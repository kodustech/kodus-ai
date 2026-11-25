import { Inject, Injectable } from '@nestjs/common';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    CODE_AREA_RISK_MAP_SERVICE_TOKEN,
    ICodeAreaRiskMapService,
} from '@libs/platformData/domain/code-area-risk/code-area-risk-map.contract';
import {
    CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN,
    IConditionalApprovalAccessService,
} from '@libs/code-review/domain/approval/conditional-approval-access.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    assessPrRiskWithLevel,
    prRiskSnapshot,
} from '@libs/code-review/domain/risk/assess-pr-risk';
import {
    matchesRiskSnapshot,
    type RiskAssessmentResult,
} from '@libs/code-review/domain/risk/risk-assessment';
import { isByokConfig, LLM_TASK } from '@libs/llm/byok-config';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { createLogger } from '@libs/core/log/logger';
import type {
    CodeReviewConfig,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { hasCompletePrFileList } from '@libs/code-review/domain/review-files';
import { riskCriteriaSchema } from '@libs/core/infrastructure/config/types/general/risk-assessment';
import type { RiskSecondLookResult } from '@libs/code-review/domain/risk/risk-assessment';
import { buildChangeRiskDiff } from '@libs/code-review/domain/risk/assess-change-risk';
import {
    createRiskSecondLook,
    riskAgentRun,
    RISK_LOOK_TOOLS,
} from '@libs/code-review/domain/risk/risk-second-look';
import { buildFinderToolRegistry } from '@libs/code-review/infrastructure/agents/adapters/finder-tools.adapter';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

export interface PrRiskAssessmentRequest {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string };
    pullRequest: {
        number: number;
        title: string;
        body?: string;
        head?: { sha?: string };
        base?: { sha?: string };
        stats?: { total_files: number };
        changedFilesCount?: number;
    };
    codeReviewConfig?: Pick<
        CodeReviewConfig,
        'riskAssessmentActive' | 'riskCriteria' | 'languageResultPrompt'
    >;
    origin: string;
    lastExecution?: { riskAssessment?: RiskAssessmentResult };
    fullPrFiles?: FileChange[];
    riskConfigurationUnavailable?: boolean;
}

export interface PrRiskSecondLookRequest {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string; fullName?: string };
    pullRequest: { number: number; title: string; body?: string };
    language?: string;
    risk: RiskAssessmentResult | undefined;
    level: PrRiskAssessmentResponse['level'];
    files: FileChange[];
    /** The review's sandbox clone of the PR head. */
    remoteCommands: RemoteCommands;
}

export interface PrRiskAssessmentResponse {
    assessment: RiskAssessmentResult;
    /** The judgment's level, for the pipeline only: a medium one gets a second look. */
    level?: 'low' | 'medium' | 'high';
    fullPrFiles?: FileChange[];
}

@Injectable()
export class PrRiskAssessmentService {
    readonly stageName = 'PrRiskAssessmentService';
    private readonly logger = createLogger(PrRiskAssessmentService.name);

    constructor(
        private readonly codeManagement: CodeManagementService,
        @Inject(CODE_AREA_RISK_MAP_SERVICE_TOKEN)
        private readonly areaMaps: ICodeAreaRiskMapService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParameters: IOrganizationParametersService,
        @Inject(CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN)
        private readonly access: IConditionalApprovalAccessService,
        private readonly permissions: PermissionValidationService,
    ) {}

    async assess(
        context: PrRiskAssessmentRequest,
    ): Promise<PrRiskAssessmentResponse> {
        let fullPrFiles = context.fullPrFiles;
        const unavailable = (
            reason: string,
            expected?: true,
        ): PrRiskAssessmentResponse => ({
            assessment: {
                status: 'unavailable',
                reason,
                ...(expected ? { expected } : {}),
            },
            fullPrFiles,
        });
        // Also set when only approval settings failed: then no assessment was
        // part of this review, and that failure is not the risk stage's.
        if (context.riskConfigurationUnavailable)
            return unavailable(
                'Kody could not resolve PR-wide risk settings.',
                context.codeReviewConfig?.riskAssessmentActive !== true ||
                    undefined,
            );
        // Absent is a legacy configuration, handled by the existing approval
        // path until the scope migration explicitly enables shared assessment.
        if (context.codeReviewConfig?.riskAssessmentActive !== true) {
            return { assessment: { status: 'disabled' }, fullPrFiles };
        }
        if (context.origin === 'cli')
            return unavailable(
                'PR risk assessment requires a provider PR snapshot.',
                true,
            );
        try {
            const criteria = riskCriteriaSchema.safeParse(
                context.codeReviewConfig.riskCriteria ?? [],
            );
            if (!criteria.success)
                return unavailable('Risk criteria are invalid.');
            const { organizationAndTeamData, repository, pullRequest } =
                context;
            if (!(await this.access.isEnabled(organizationAndTeamData))) {
                return unavailable(
                    'Risk assessment is unavailable for this organization.',
                );
            }
            const organizationId = organizationAndTeamData.organizationId;
            const headSha = pullRequest.head?.sha;
            const baseSha = pullRequest.base?.sha;
            if (!organizationId || !headSha || !baseSha) {
                return unavailable(
                    'Kody could not verify the complete PR snapshot.',
                );
            }
            // Full provider diff, not preliminaryFiles (which may be incremental),
            // and no ignorePaths filtering: removals and old rename paths matter.
            const files =
                fullPrFiles ??
                (await this.codeManagement.getFilesByPullRequestId({
                    organizationAndTeamData,
                    repository,
                    prNumber: pullRequest.number,
                    headSha,
                    baseSha,
                }));
            if (!hasCompletePrFileList(files, pullRequest.changedFilesCount)) {
                return unavailable(
                    'Kody could not verify the complete PR diff.',
                );
            }
            const live = await this.codeManagement.getPullRequest({
                organizationAndTeamData,
                repository,
                prNumber: pullRequest.number,
            });
            if (live?.head?.sha !== headSha || live?.base?.sha !== baseSha) {
                return unavailable(
                    'The PR changed while Kody was reading its diff.',
                    true,
                );
            }
            if (!hasCompletePrFileList(files, live.changedFilesCount))
                return unavailable(
                    'Kody could not verify the complete PR diff.',
                );
            fullPrFiles = files;
            const stored = await this.organizationParameters.findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                organizationAndTeamData,
            );
            const { slot, verdict } = resolveTaskSlot(
                isByokConfig(stored?.configValue)
                    ? stored.configValue
                    : undefined,
                LLM_TASK.riskAssessment,
            );
            if (verdict && !verdict.modelId)
                return unavailable(
                    'No eligible risk assessment model is available.',
                );
            const areaMap = await this.areaMaps.read(
                organizationId,
                repository.id,
            );
            const assessmentInput = {
                organizationId,
                repositoryId: repository.id,
                prNumber: pullRequest.number,
                baseSha,
                headSha,
                title: pullRequest.title,
                body: pullRequest.body,
                files,
                criteria: criteria.data,
                language: context.codeReviewConfig.languageResultPrompt,
                areaMap,
                modelSlot: slot,
            };
            if (
                matchesRiskSnapshot(
                    context.lastExecution?.riskAssessment,
                    prRiskSnapshot(assessmentInput),
                )
            ) {
                return {
                    assessment: context.lastExecution.riskAssessment,
                    fullPrFiles,
                };
            }
            if (
                await this.permissions.gateKodusCreditsForSlot(
                    slot,
                    organizationAndTeamData,
                    this.stageName,
                )
            ) {
                return unavailable(
                    'Risk assessment could not run with the available model credits.',
                );
            }
            const { assessment, level } =
                await assessPrRiskWithLevel(assessmentInput);
            return { assessment, level, fullPrFiles };
        } catch (error) {
            this.logger.warn({
                message: 'Shared PR risk assessment unavailable',
                context: this.stageName,
                metadata: {
                    ...context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    repositoryId: context.repository.id,
                },
                error,
            });
            return {
                assessment: {
                    status: 'unavailable',
                    reason: 'Kody could not assess risk for this PR.',
                    failure: {
                        category: 'unexpected',
                        errorName:
                            error instanceof Error
                                ? error.name
                                : 'UnknownError',
                    },
                },
                fullPrFiles,
            };
        }
    }

    /**
     * The second look at a medium rating in the review's sandbox: the risk
     * model with the review's own repository tools, gated by the same credits.
     * Undefined keeps the first judgment, including on any failure.
     */
    async secondLook(
        request: PrRiskSecondLookRequest,
    ): Promise<RiskSecondLookResult | undefined> {
        const { risk, organizationAndTeamData, pullRequest } = request;
        if (
            risk?.status !== 'assessed' ||
            !risk.riskIdentified ||
            request.level !== 'medium' ||
            !organizationAndTeamData.organizationId
        )
            return undefined;
        try {
            const stored = await this.organizationParameters.findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                organizationAndTeamData,
            );
            const { slot, verdict } = resolveTaskSlot(
                isByokConfig(stored?.configValue)
                    ? stored.configValue
                    : undefined,
                LLM_TASK.riskAssessment,
            );
            if (verdict && !verdict.modelId) return undefined;
            if (
                await this.permissions.gateKodusCreditsForSlot(
                    slot,
                    organizationAndTeamData,
                    this.stageName,
                )
            )
                return undefined;
            const { registry } = buildFinderToolRegistry({
                remoteCommands: request.remoteCommands,
                repositoryFullName: request.repository.fullName,
            });
            const cleared = await createRiskSecondLook(
                riskAgentRun(slot, {
                    organizationId: organizationAndTeamData.organizationId,
                    prNumber: pullRequest.number,
                }),
            )({
                title: pullRequest.title,
                body: pullRequest.body ?? '',
                diff: buildChangeRiskDiff(request.files),
                reason: risk.reason,
                language: request.language,
                tools: registry
                    .list()
                    .filter((tool) => RISK_LOOK_TOOLS.includes(tool.name)),
            });
            return cleared
                ? {
                      assessmentKey: risk.snapshot.assessmentKey,
                      reason: cleared.reason,
                      evidence: cleared.evidence,
                  }
                : undefined;
        } catch (error) {
            this.logger.warn({
                message: 'Risk second look failed; the first judgment stands',
                context: this.stageName,
                metadata: {
                    ...organizationAndTeamData,
                    prNumber: pullRequest.number,
                    repositoryId: request.repository.id,
                },
                error,
            });
            return undefined;
        }
    }
}
