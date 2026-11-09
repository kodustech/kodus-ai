import { Inject, Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { createLogger } from '@libs/core/log/logger';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import {
    CODE_AREA_RISK_MAP_SERVICE_TOKEN,
    ICodeAreaRiskMapService,
} from '@libs/platformData/domain/code-area-risk/code-area-risk-map.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    approvalPathsOf,
    approvalPolicyForPlatform,
    approvalPolicyFromConfig,
    evaluateApproval,
    matchesApprovalScope,
    type ApprovalRiskAssessment,
} from '@libs/code-review/domain/approval/approval-decision';
import { assessApprovalRisk } from '@libs/code-review/domain/approval/assess-approval-risk';
import { reviewsOnlyIgnoredFiles } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';
import { riskApprovalVeto } from '@libs/code-review/domain/risk/risk-assessment';
import {
    CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN,
    IConditionalApprovalAccessService,
} from '@libs/code-review/domain/approval/conditional-approval-access.contract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { ApprovalPoliciesService } from '../services/approval-policies.service';
import { SUMMARY_GENERATION_FAILED_REASON } from './finish-comments.stage';

@Injectable()
export class DecidePrApprovalStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'DecidePrApprovalStage';
    readonly label = 'Checking approval policies';
    readonly visibility = StageVisibility.SECONDARY;
    readonly errorSeverity = 'partial' as const;

    private readonly logger = createLogger(DecidePrApprovalStage.name);

    constructor(
        private readonly codeManagement: CodeManagementService,
        @Inject(CODE_AREA_RISK_MAP_SERVICE_TOKEN)
        private readonly areaMaps: ICodeAreaRiskMapService,
        @Inject(CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN)
        private readonly conditionalApprovalAccess: IConditionalApprovalAccessService,
        private readonly approvalPolicies: ApprovalPoliciesService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const config = context.codeReviewConfig;
        const hasBlockingFailure = (context.errors ?? []).some(
            (error) =>
                error.metadata?.reason !== SUMMARY_GENERATION_FAILED_REASON &&
                ['critical', 'partial'].includes(error.severity ?? 'critical'),
        );
        if (
            !config?.pullRequestApprovalActive ||
            context.onlyCustomAgent ||
            reviewsOnlyIgnoredFiles(context) ||
            context.origin === 'cli'
        ) {
            return context;
        }
        if (config.approvalPolicies !== undefined) {
            const result = await this.approvalPolicies.evaluate({
                organizationAndTeamData: context.organizationAndTeamData,
                repository: context.repository,
                pullRequest: context.pullRequest,
                config,
                platformType: context.platformType,
                reviewClean:
                    (context.lineComments?.length ?? 0) === 0 &&
                    (context.prLevelCommentResults?.length ?? 0) === 0 &&
                    !hasBlockingFailure,
                risk: context.riskAssessment,
                fullPrFiles: context.fullPrFiles,
                heavy: context.heavy,
                previousEligibility:
                    context.lastExecution?.approvalPolicyEligibility,
            });
            return this.updateContext(context, (draft) => {
                draft.approvalDecision = result.decision;
                draft.approvalPolicyEligibility = result.eligibility;
                draft.approvalReviewSummary = {
                    lineFindings: context.lineComments?.length ?? 0,
                    prFindings: context.prLevelCommentResults?.length ?? 0,
                    complete:
                        Array.isArray(context.lineComments) &&
                        !hasBlockingFailure,
                };
            });
        }
        const configuredPolicy = approvalPolicyFromConfig(config);
        if (
            context.platformType === PlatformType.AZURE_REPOS &&
            configuredPolicy.labels?.length
        ) {
            return this.updateContext(context, (draft) => {
                draft.approvalDecision = {
                    kind: 'hold',
                    reason: 'The provider cannot verify approval labels.',
                };
            });
        }
        const policy = approvalPolicyForPlatform(
            configuredPolicy,
            context.platformType,
        );
        if (
            !policy.labels?.length &&
            !policy.authors?.length &&
            !policy.assessRisk &&
            !policy.sensitivePaths?.length
        ) {
            return context;
        }

        const { pullRequest, organizationAndTeamData, repository } = context;
        if (
            !(await this.conditionalApprovalAccess.isEnabled(
                organizationAndTeamData,
            ))
        ) {
            return this.updateContext(context, (draft) => {
                draft.approvalDecision = {
                    kind: 'hold',
                    reason: 'Conditional approval is unavailable for this organization.',
                };
            });
        }
        const organizationId = organizationAndTeamData.organizationId;
        if (!organizationId) {
            return this.updateContext(context, (draft) => {
                draft.approvalDecision = {
                    kind: 'hold',
                    reason: 'Kody could not identify the organization for risk assessment.',
                };
            });
        }
        const headSha = pullRequest.head?.sha ?? '';
        let labels = pullRequest.tags ?? [];
        let author =
            pullRequest.user?.username ?? pullRequest.user?.login ?? '';
        const livePr = await this.codeManagement.getPullRequest({
            organizationAndTeamData,
            repository,
            prNumber: pullRequest.number,
            includeLabels: !!policy.labels?.length,
        });
        if (
            !livePr ||
            (headSha && livePr.head?.sha !== headSha) ||
            (policy.labels?.length && !livePr.labels)
        ) {
            return this.updateContext(context, (draft) => {
                draft.approvalDecision = {
                    kind: 'hold',
                    reason: 'Kody could not verify the current PR head and labels.',
                };
            });
        }
        labels = livePr.labels ?? labels;
        author = livePr.user?.login ?? author;
        const authorScope = matchesApprovalScope({
            policy: { authors: policy.authors },
            author,
        });
        if (!authorScope.matches) {
            return this.updateContext(context, (draft) => {
                draft.approvalDecision = {
                    kind: 'out-of-scope',
                    reason:
                        authorScope.reason ??
                        'The PR author is outside the approval scope.',
                };
            });
        }

        // Incremental reviews may contain only files changed since Kody's last
        // run. Approval and team path vetoes apply to the entire current PR.
        const needsFiles = policy.assessRisk || !!policy.sensitivePaths?.length;
        const fullFiles = needsFiles
            ? (context.fullPrFiles ??
              (await this.codeManagement.getFilesByPullRequestId({
                  organizationAndTeamData,
                  repository,
                  prNumber: pullRequest.number,
                  headSha,
              })))
            : [];
        if (
            needsFiles &&
            (!fullFiles?.length ||
                fullFiles.some((file) => typeof file.filename !== 'string'))
        ) {
            return this.updateContext(context, (draft) => {
                draft.approvalDecision = {
                    kind: 'hold',
                    reason: 'Kody could not verify the complete PR diff.',
                };
            });
        }
        const paths = approvalPathsOf(fullFiles);

        const sensitive = paths.some((path) =>
            isFileMatchingGlob(path, policy.sensitivePaths ?? []),
        );
        // Compatibility projection for persisted executions and the approval
        // cron. Shared consumers use riskAssessment, never these old levels.
        const sharedRisk = context.riskAssessment;
        let risk: ApprovalRiskAssessment | undefined =
            config.riskAssessmentActive === true
                ? {
                      level:
                          sharedRisk?.status === 'assessed'
                              ? ((sharedRisk.riskIdentified
                                    ? 'high'
                                    : 'low') as 'high' | 'low')
                              : ('unknown' as const),
                      reason:
                          sharedRisk && sharedRisk.status !== 'disabled'
                              ? sharedRisk.reason
                              : 'Risk assessment is unavailable.',
                      reviewedHeadSha:
                          sharedRisk?.status === 'assessed'
                              ? sharedRisk.snapshot.headSha
                              : headSha,
                      areaMapVersion:
                          sharedRisk?.status === 'assessed'
                              ? sharedRisk.areaMapVersion
                              : undefined,
                      failure:
                          sharedRisk?.status === 'unavailable'
                              ? sharedRisk.failure
                              : undefined,
                  }
                : undefined;
        // Preserve the assessment even if the required label arrives after
        // review; the cron can then reconsider this exact reviewed head.
        if (
            policy.assessRisk &&
            config.riskAssessmentActive === undefined &&
            !sensitive &&
            headSha
        ) {
            let areaMap;
            try {
                const storedMap = await this.areaMaps.read(
                    organizationId,
                    repository.id,
                );
                // Partial history still contains positive bug evidence. The
                // assessment receives coverage and treats missing areas as
                // unknown rather than as proof of safety.
                areaMap = storedMap;
            } catch (error) {
                this.logger.warn({
                    message: 'Area map unavailable during approval assessment',
                    context: this.stageName,
                    error,
                });
                return this.updateContext(context, (draft) => {
                    draft.approvalDecision = {
                        kind: 'hold',
                        reason: 'Kody could not load historical risk evidence.',
                    };
                });
            }
            risk = await assessApprovalRisk({
                organizationId,
                prNumber: pullRequest.number,
                title: pullRequest.title,
                body: pullRequest.body,
                headSha,
                files: fullFiles,
                teamInstructions: policy.riskInstructions,
                language: config.languageResultPrompt,
                areaMap,
                modelSlot: config.resolvedModelSlot,
            });
        }
        const sharedVeto =
            config.riskAssessmentActive === true
                ? riskApprovalVeto(true, sharedRisk, headSha)
                : undefined;
        const decision = sharedVeto
            ? { kind: 'hold' as const, reason: sharedVeto }
            : evaluateApproval({
                  approvalActive: true,
                  policy,
                  author,
                  labels,
                  changedPaths: paths,
                  reviewClean:
                      (context.lineComments?.length ?? 0) === 0 &&
                      (context.prLevelCommentResults?.length ?? 0) === 0 &&
                      !hasBlockingFailure,
                  risk,
                  currentHeadSha: headSha,
              });
        return this.updateContext(context, (draft) => {
            draft.approvalRisk = risk;
            draft.approvalDecision = decision;
            if (risk?.level === 'unknown') {
                draft.errors ??= [];
                draft.errors.push({
                    stage: this.stageName,
                    severity: 'partial',
                    error: new Error(risk.reason),
                    metadata: {
                        reason: 'approval_risk_assessment_failed',
                        ...risk.failure,
                    },
                });
            }
        });
    }
}
