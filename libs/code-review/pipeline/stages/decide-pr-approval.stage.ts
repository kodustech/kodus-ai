import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { createLogger } from '@libs/core/log/logger';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { CodeAreaRiskMapService } from '@libs/platformData/infrastructure/adapters/services/code-area-risk-map.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    approvalPolicyFromConfig,
    evaluateApproval,
    matchesApprovalScope,
} from '@libs/code-review/domain/approval/approval-decision';
import { assessApprovalRisk } from '@libs/code-review/domain/approval/assess-approval-risk';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class DecidePrApprovalStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'DecidePrApprovalStage';
    readonly label = 'Assessing approval risk';
    readonly visibility = StageVisibility.SECONDARY;
    readonly errorSeverity = 'partial' as const;

    private readonly logger = createLogger(DecidePrApprovalStage.name);

    constructor(
        private readonly codeManagement: CodeManagementService,
        private readonly areaMaps: CodeAreaRiskMapService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const config = context.codeReviewConfig;
        if (
            !config?.pullRequestApprovalActive ||
            context.onlyCustomAgent ||
            context.origin === 'cli'
        ) {
            return context;
        }
        const policy = approvalPolicyFromConfig(config);
        if (
            !policy.labels?.length &&
            !policy.authors?.length &&
            !policy.assessRisk &&
            !policy.sensitivePaths?.length
        ) {
            return context;
        }

        const { pullRequest, organizationAndTeamData, repository } = context;
        const organizationId = organizationAndTeamData.organizationId;
        if (!organizationId) {
            return this.updateContext(context, (draft) => {
                draft.approvalDecision = {
                    kind: 'hold',
                    reason: 'Kody could not identify the organization for risk assessment.',
                };
            });
        }
        const paths = [
            ...new Set(
                [
                    ...(context.preliminaryFiles ?? []),
                    ...(context.changedFiles ?? []),
                    ...(context.ignoredFileChanges ?? []),
                ].map((file) => file.filename),
            ),
        ];
        const headSha = pullRequest.head?.sha ?? '';
        let labels = pullRequest.tags ?? [];
        let author =
            pullRequest.user?.username ?? pullRequest.user?.login ?? '';
        const livePr = await this.codeManagement.getPullRequest({
            organizationAndTeamData,
            repository,
            prNumber: pullRequest.number,
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

        const scope = matchesApprovalScope({ policy, author, labels });
        const sensitive = paths.some((path) =>
            isFileMatchingGlob(path, policy.sensitivePaths ?? []),
        );
        let risk = undefined;
        if (policy.assessRisk && !sensitive && headSha) {
            let areaMap = null;
            try {
                areaMap = await this.areaMaps.read(
                    organizationId,
                    repository.id,
                );
            } catch (error) {
                this.logger.warn({
                    message: 'Area map unavailable during approval assessment',
                    context: this.stageName,
                    error,
                });
            }
            risk = await assessApprovalRisk({
                organizationId,
                prNumber: pullRequest.number,
                title: pullRequest.title,
                body: pullRequest.body,
                headSha,
                files: [
                    ...(context.changedFiles ?? []),
                    ...(context.ignoredFileChanges ?? []),
                ],
                teamInstructions: policy.riskInstructions,
                language: config.languageResultPrompt,
                areaMap,
                modelSlot: config.resolvedModelSlot,
            });
        }
        const decision = evaluateApproval({
            approvalActive: true,
            policy,
            author,
            labels,
            changedPaths: paths,
            reviewClean:
                (context.lineComments?.length ?? 0) === 0 &&
                (context.prLevelCommentResults?.length ?? 0) === 0 &&
                !(context.errors ?? []).some((error) =>
                    ['critical', 'partial'].includes(
                        error.severity ?? 'critical',
                    ),
                ),
            risk,
            currentHeadSha: headSha,
        });
        return this.updateContext(context, (draft) => {
            draft.approvalRisk = risk;
            draft.approvalDecision = decision;
        });
    }
}
