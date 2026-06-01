import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { Injectable } from '@nestjs/common';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { createLogger } from '@kodus/flow';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CommentResult } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
// SeverityLevel no longer used — request changes is driven by level classification
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class RequestChangesOrApproveStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'RequestChangesOrApproveStage';
    readonly label = 'Finalizing Review';
    readonly visibility = StageVisibility.PRIMARY;
    readonly errorSeverity = 'partial' as const;

    private readonly logger = createLogger(RequestChangesOrApproveStage.name);

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly notificationService: NotificationService,
        private readonly prAuthorRecipientResolver: PrAuthorRecipientResolver,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const {
            lineComments,
            pullRequest,
            organizationAndTeamData,
            repository,
            codeReviewConfig,
        } = context;

        if (!lineComments) {
            this.logger.warn({
                message: `No line comments available for PR#${pullRequest.number}, skipping request changes/approve`,
                context: this.stageName,
            });
            return context;
        }

        // Solicitar mudanças se houver comentários críticos
        await this.requestChangesIfCritical(
            codeReviewConfig.isRequestChangesActive,
            pullRequest.number,
            organizationAndTeamData,
            repository,
            lineComments,
        );

        // Any non-empty severity blocks auto-approve so we never signal
        // "all good" on a degraded run. The user-facing message tells
        // them which auxiliary checks failed and where to look for the
        // details; here we just refuse to approve.
        const reviewHasFailures = (context.errors ?? []).some(
            (e) =>
                (e?.severity ?? 'critical') === 'critical' ||
                e?.severity === 'partial',
        );

        const approved = await this.approvePullRequest(
            codeReviewConfig.pullRequestApprovalActive,
            lineComments.length,
            organizationAndTeamData,
            pullRequest.number,
            repository,
            reviewHasFailures,
        );

        if (approved) {
            await this.notifyAutoApproved(context);
        }

        this.logger.log({
            message: `Finished processing PR#${pullRequest.number}`,
            context: this.stageName,
            metadata: {
                lineCommentsCount: lineComments.length,
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            },
        });

        return context;
    }

    /**
     * Solicita mudanças no PR se houver comentários críticos
     */
    private async requestChangesIfCritical(
        isRequestChanges: boolean,
        prNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        lineComments: CommentResult[],
    ): Promise<void> {
        try {
            if (!isRequestChanges) {
                return;
            }

            const criticalComments = lineComments.filter((comment) => {
                const severity =
                    comment.comment.suggestion?.severity?.toLowerCase();
                return severity === 'critical';
            });

            if (criticalComments.length === 0) {
                return;
            }

            this.logger.log({
                message: `Requesting changes for PR#${prNumber} due to ${criticalComments.length} critical comments`,
                context: this.stageName,
            });

            await this.codeManagementService.requestChangesPullRequest({
                organizationAndTeamData,
                prNumber,
                repository,
                criticalComments,
            });
        } catch (error) {
            this.logger.error({
                message: `Error requesting changes for PR#${prNumber}`,
                error,
                context: this.stageName,
            });
        }
    }

    /**
     * Aprova o PR se não houver comentários. Returns true when the PR
     * transitioned from unapproved to approved in this call (i.e. the
     * caller should fire the auto-approved notification). Returns false
     * when the approve was skipped (config off, comments present, or
     * already approved) or when the approve threw.
     */
    private async approvePullRequest(
        pullRequestApprovalActive: boolean,
        lineCommentsLength: number,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { id: string; name: string },
        reviewHasFailures: boolean,
    ): Promise<boolean> {
        try {
            if (!pullRequestApprovalActive || lineCommentsLength > 0) {
                return false;
            }

            // Any failure (critical or partial) means we couldn't fully
            // analyze the PR — 0 line comments here is unanalyzed, not
            // clean. Approving here would signal "all good" when the
            // truth is "we couldn't tell." User must re-run (`@kody
            // review` after fixing the cause) before auto-approve can
            // re-engage.
            if (reviewHasFailures) {
                this.logger.log({
                    message: `Skipping auto-approve for PR#${prNumber} because the review had failures`,
                    context: this.stageName,
                    metadata: {
                        prNumber,
                        repository,
                    },
                });
                return false;
            }

            const status =
                await this.codeManagementService.getReviewStatusByPullRequest({
                    organizationAndTeamData,
                    prNumber,
                    repository,
                });

            if (status === PullRequestReviewState.APPROVED) {
                this.logger.log({
                    message: `PR#${prNumber} is already approved, skipping approval`,
                    metadata: { currentStatus: status, prNumber, repository },
                    context: this.stageName,
                });
                return false;
            }

            const message =
                status === PullRequestReviewState.CHANGES_REQUESTED
                    ? `Clearing previous requested changes by approving PR#${prNumber}.`
                    : `Approving PR#${prNumber} as no new issues were found and status is clear.`;

            this.logger.log({
                message,
                metadata: { currentStatus: status, prNumber, repository },
                context: this.stageName,
            });

            await this.codeManagementService.approvePullRequest({
                organizationAndTeamData,
                prNumber,
                repository,
            });
            return true;
        } catch (error) {
            this.logger.error({
                message: `Error approving PR#${prNumber}`,
                error,
                context: this.stageName,
            });
            return false;
        }
    }

    /**
     * Notify the PR author that their pull request was auto-approved.
     * Best-effort: bot authors are filtered, external contributors with
     * no internal user are silently skipped, and any unexpected error
     * is swallowed (never break the review pipeline over a notification).
     */
    private async notifyAutoApproved(
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        try {
            const { pullRequest, organizationAndTeamData, repository } =
                context;
            const author = pullRequest?.user as
                | { email?: string; username?: string }
                | undefined;

            const recipient = await this.prAuthorRecipientResolver.resolve(
                { email: author?.email, login: author?.username },
                organizationAndTeamData.organizationId,
            );
            if (!recipient) return;

            await this.notificationService.emit({
                event: NotificationEvent.REVIEW_AUTO_APPROVED,
                payload: {
                    prUrl: (pullRequest?.url as string) ?? '',
                    repoName: repository?.name ?? '',
                    approvedAt: new Date().toISOString(),
                },
                organizationId: organizationAndTeamData.organizationId,
                recipients: recipient,
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to emit review.auto_approved notification',
                error: error instanceof Error ? error : new Error(String(error)),
                context: this.stageName,
            });
        }
    }
}
