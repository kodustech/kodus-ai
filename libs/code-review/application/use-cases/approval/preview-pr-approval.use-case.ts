import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    type IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import { approvalPathsOf } from '@libs/code-review/domain/approval/approval-decision';
import { reviewExecutionAllowsApproval } from '@libs/code-review/domain/approval/review-approval-errors';
import { approvalPolicyProviderError } from '@libs/code-review/domain/approval/approval-policy-provider';
import {
    REVIEW_FINDINGS_UNVERIFIED,
    deliveredReviewFindingsHoldReason,
} from '@libs/code-review/domain/approval/verify-delivered-review-findings';
import { usesNamedApprovalPolicies } from '@libs/code-review/domain/approval/migrate-review-settings';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    type ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { hasCompletePrFileList } from '@libs/code-review/domain/review-files';
import { pullRequestHost } from '@libs/code-review/domain/pull-request-identity';
import { resolveRiskReviewMode } from '@libs/code-review/domain/review-mode';
import { ApprovalPoliciesService } from '@libs/code-review/pipeline/services/approval-policies.service';
import { PrRiskAssessmentService } from '@libs/code-review/pipeline/services/pr-risk-assessment.service';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    PlatformType,
    parsePlatformType,
} from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { approvalPoliciesSchema } from '@libs/core/infrastructure/config/types/general/approval-policies';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { isHeavyModePlanAllowed } from '@libs/ee/heavy-mode/heavy-mode-plan';
import {
    LICENSE_SERVICE_TOKEN,
    type ILicenseService,
} from '@libs/ee/license/interfaces/license.interface';
import {
    PARAMETERS_SERVICE_TOKEN,
    type IParametersService,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    PULL_REQUESTS_SERVICE_TOKEN,
    type IPullRequestsService,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import type { IDeliveredSuggestion } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

@Injectable()
export class PreviewPrApprovalUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parameters: IParametersService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly configs: ICodeBaseConfigService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly executions: IAutomationExecutionService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly license: ILicenseService,
        private readonly codeManagement: CodeManagementService,
        private readonly risk: PrRiskAssessmentService,
        private readonly approval: ApprovalPoliciesService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequests: IPullRequestsService,
    ) {}

    async execute(input: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        prNumber: number;
        policies?: unknown[];
        assumeClean?: boolean;
        assumeEnabled?: boolean;
    }) {
        const { organizationAndTeamData, prNumber } = input;
        const override =
            input.policies === undefined
                ? undefined
                : approvalPoliciesSchema.safeParse(input.policies);
        if (override && !override.success) {
            throw new BadRequestException('Approval policies are invalid.');
        }

        const parameter = await this.parameters.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );
        const storedConfig = parameter?.configValue;
        const saved = storedConfig?.repositories?.find(
            (repo) => repo.id === input.repositoryId,
        );
        if (!storedConfig || !saved || saved.isSelected === false) {
            throw new NotFoundException('Repository not found in this team.');
        }

        const repository = { id: saved.id, name: saved.name };
        const request = { organizationAndTeamData, repository, prNumber };
        const platformType = await this.codeManagement.getTypeIntegration(
            organizationAndTeamData,
        );
        const providerError =
            override?.data &&
            approvalPolicyProviderError(override.data, platformType);
        if (providerError) throw new BadRequestException(providerError);
        const pr = await this.codeManagement.getPullRequest(
            request,
            platformType,
        );
        if (!pr) throw new NotFoundException('Pull request not found.');

        const snapshot = { headSha: pr.head?.sha, baseSha: pr.base?.sha };
        const assumptions = {
            cleanReview: input.assumeClean === true,
            automaticApproval: input.assumeEnabled === true,
            draftPolicies: override !== undefined,
        };
        const hold = (reason: string) => ({
            snapshot,
            assumptions,
            decision: { kind: 'hold' as const, reason },
        });

        if (!snapshot.headSha || !snapshot.baseSha) {
            return hold('The current PR snapshot could not be verified.');
        }
        const files = await this.codeManagement.getFilesByPullRequestId(
            { ...request, ...snapshot },
            platformType,
        );
        if (!hasCompletePrFileList(files, pr.changedFilesCount)) {
            return hold('The complete PR file list could not be verified.');
        }

        const defaultBranch = await this.configs.getDefaultBranch(
            organizationAndTeamData,
            repository,
        );
        const currentConfig = await this.configs.getMergedCodeReviewConfigs(
            organizationAndTeamData,
            repository,
            storedConfig,
            defaultBranch,
            files,
        );
        const scoped = files.some(
            (file) =>
                file.previous_filename &&
                file.previous_filename !== file.filename,
        )
            ? await this.configs.getMergedCodeReviewConfigs(
                  organizationAndTeamData,
                  repository,
                  storedConfig,
                  defaultBranch,
                  approvalPathsOf(files).map((filename) => ({ filename })),
              )
            : currentConfig;
        const config = {
            ...scoped,
            reviewMode: currentConfig.reviewMode,
            approvalPolicies: override?.data ?? scoped.approvalPolicies,
            pullRequestApprovalActive:
                assumptions.automaticApproval ||
                scoped.pullRequestApprovalActive,
        };
        if (
            !override &&
            !usesNamedApprovalPolicies(config) &&
            config.pullRequestApprovalActive &&
            !config.reviewSettingsError
        ) {
            return hold(
                'This PR uses legacy approval. Supply draft named policies to preview them.',
            );
        }

        let previousHeavy: boolean | undefined;
        if (
            config.pullRequestApprovalActive &&
            !config.reviewSettingsError &&
            !assumptions.cleanReview
        ) {
            const {
                data: [latest],
            } =
                await this.executions.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        organizationAndTeamData,
                        repositoryIds: [repository.id],
                        automationType: AutomationType.AUTOMATION_CODE_REVIEW,
                        pullRequestNumber: prNumber,
                        order: 'DESC',
                        take: 1,
                    },
                );
            const data = latest?.dataExecution;
            const reviewed = data?.approvalDecision;
            if (
                reviewed?.reviewedHeadSha &&
                (reviewed.reviewedHeadSha !== snapshot.headSha ||
                    reviewed.reviewedBaseSha !== snapshot.baseSha)
            ) {
                return hold('The PR changed after its latest recorded review.');
            }
            const analyzed = data?.lastAnalyzedCommit;
            const analyzedHead =
                typeof analyzed === 'string'
                    ? analyzed
                    : (analyzed?.sha ?? analyzed?.commitSha);
            const summary = data?.approvalReviewSummary;
            if (
                !reviewExecutionAllowsApproval(latest) ||
                analyzedHead !== snapshot.headSha ||
                reviewed?.reviewedBaseSha !== snapshot.baseSha ||
                !summary?.complete ||
                summary.lineFindings !== 0 ||
                summary.prFindings !== 0
            ) {
                return hold(
                    'There is no completed, recorded clean review for this PR snapshot. Use the clean-review assumption to test policy conditions independently.',
                );
            }
            try {
                const candidates =
                    await this.pullRequests.findPullRequestsWithDeliveredSuggestions(
                        organizationAndTeamData.organizationId,
                        [prNumber],
                        [
                            PullRequestState.OPENED,
                            PullRequestState.CLOSED,
                            PullRequestState.MERGED,
                        ],
                    );
                const host = pullRequestHost(pr.prURL);
                const deliveredSuggestions: IDeliveredSuggestion[] = [];
                for (const candidate of candidates) {
                    const provider = parsePlatformType(candidate.provider);
                    if (
                        candidate.repository.id !== repository.id ||
                        (provider && provider !== platformType)
                    )
                        continue;
                    const storedHost = pullRequestHost(candidate.url);
                    if (!host || !storedHost)
                        return hold(REVIEW_FINDINGS_UNVERIFIED);
                    if (storedHost !== host) continue;
                    if (
                        !Array.isArray(candidate.suggestions) ||
                        !candidate.suggestions.length
                    )
                        return hold(REVIEW_FINDINGS_UNVERIFIED);
                    for (const suggestion of candidate.suggestions) {
                        deliveredSuggestions.push(suggestion);
                    }
                }
                const reason = await deliveredReviewFindingsHoldReason(
                    deliveredSuggestions,
                    summary,
                    platformType,
                    () =>
                        platformType === PlatformType.GITHUB
                            ? this.codeManagement.getPullRequestReviewThreads(
                                  request,
                                  platformType,
                              )
                            : this.codeManagement.getPullRequestReviewComments(
                                  request,
                                  platformType,
                              ),
                );
                if (reason) return hold(reason);
            } catch {
                return hold(REVIEW_FINDINGS_UNVERIFIED);
            }
            previousHeavy = data.heavy;
        }

        const language = await this.parameters.findByKey(
            ParametersKey.LANGUAGE_CONFIG,
            organizationAndTeamData,
        );
        const resolvedConfig = {
            ...config,
            languageResultPrompt:
                typeof language?.configValue === 'string'
                    ? language.configValue
                    : 'en-US',
        };
        const risk =
            config.pullRequestApprovalActive &&
            !config.reviewSettingsError &&
            config.riskAssessmentActive
                ? (
                      await this.risk.assess({
                          organizationAndTeamData,
                          repository,
                          pullRequest: { ...pr, number: prNumber },
                          codeReviewConfig: resolvedConfig,
                          origin: 'preview',
                          fullPrFiles: files,
                      })
                  ).assessment
                : undefined;
        const configuredHeavy =
            resolveRiskReviewMode({
                configured: config.reviewMode,
                routing: config.riskReviewRouting,
                risk,
                currentHeadSha: snapshot.headSha,
                heavyAllowed: true,
            }) === 'heavy';
        const heavy =
            previousHeavy ??
            (configuredHeavy &&
                (await isHeavyModePlanAllowed(
                    this.license,
                    organizationAndTeamData,
                    PreviewPrApprovalUseCase.name,
                )));

        const { decision } = await this.approval.evaluate({
            organizationAndTeamData,
            repository,
            pullRequest: { ...pr, number: prNumber },
            config: resolvedConfig,
            platformType,
            reviewClean: true,
            risk,
            fullPrFiles: files,
            heavy,
        });
        return {
            snapshot,
            assumptions,
            decision: {
                kind: decision.kind,
                reason: decision.reason,
                matchedPolicy: decision.matchedPolicy,
                policies: decision.policies,
            },
        };
    }
}
