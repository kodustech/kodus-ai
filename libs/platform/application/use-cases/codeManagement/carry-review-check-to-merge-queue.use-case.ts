import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { classifyGitHubError } from '@libs/core/workflow/domain/errors/classify-github-error';
import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { KODY_CHECK_RUN_NAME } from '@libs/core/infrastructure/pipeline/services/pipeline-checks.service';
import { createLogger } from '@libs/core/log/logger';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';
import { IWebhookEventParams } from '@libs/platform/domain/platformIntegrations/interfaces/webhook-event-handler.interface';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import {
    isMergeQueuePush,
    parseMergeQueueRef,
} from '@libs/platform/infrastructure/webhooks/github/merge-queue-ref';
import { Injectable } from '@nestjs/common';

export type CarryReviewCheckResult =
    | { carried: true; conclusion: string }
    | {
          carried: false;
          reason:
              | 'not_merge_queue_push'
              | 'no_context'
              | 'not_in_merge_queue'
              | 'pr_lookup_failed'
              | 'no_completed_run'
              | 'api_error';
      };

/**
 * GitHub's merge queue waits for every required check on the commit it
 * builds for a queued PR. Kody reports on the PR head only, so this copies
 * the PR head's newest finished Kody result onto the queue commit. No review
 * runs here. With no finished result nothing is posted, as for the PR itself.
 */
@Injectable()
export class CarryReviewCheckToMergeQueueUseCase {
    private readonly logger = createLogger(
        CarryReviewCheckToMergeQueueUseCase.name,
    );

    constructor(
        private readonly webhookContextService: WebhookContextService,
        private readonly codeManagement: CodeManagementService,
        private readonly githubChecksService: GithubChecksService,
    ) {}

    async execute(
        params: Pick<IWebhookEventParams, 'event' | 'payload'>,
    ): Promise<CarryReviewCheckResult> {
        const { event, payload } = params;

        if (!isMergeQueuePush(event, payload)) {
            return { carried: false, reason: 'not_merge_queue_push' };
        }

        const { prNumber } = parseMergeQueueRef(payload.ref);
        const queueSha: string = payload.after;
        const repositoryId = String(payload.repository?.id);
        const repositoryName: string = payload.repository?.name;
        const owner: string = payload.repository?.full_name?.split('/')[0];

        const metadata: Record<string, unknown> = {
            repositoryId,
            repositoryName,
            prNumber,
            queueSha,
            queueRef: payload.ref,
        };

        const done = (result: CarryReviewCheckResult, error?: unknown) => {
            const message =
                'reason' in result
                    ? `Kody check not carried to merge queue commit: ${result.reason}`
                    : 'Carried Kody check to merge queue commit';
            const logMetadata = { ...metadata, ...result };

            if (error) {
                this.logger.error({
                    message,
                    context: CarryReviewCheckToMergeQueueUseCase.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: logMetadata,
                });
            } else {
                this.logger.log({
                    message,
                    context: CarryReviewCheckToMergeQueueUseCase.name,
                    metadata: logMetadata,
                });
            }

            return result;
        };

        try {
            const context = await this.webhookContextService.getContext(
                PlatformType.GITHUB,
                repositoryId,
            );
            if (!context?.organizationAndTeamData) {
                return done({ carried: false, reason: 'no_context' });
            }

            const { organizationAndTeamData } = context;
            metadata.organizationId = organizationAndTeamData.organizationId;
            metadata.teamId = organizationAndTeamData.teamId;

            const repository = { owner, name: repositoryName };

            const queueEntrySha =
                await this.githubChecksService.findMergeQueueEntryHeadSha({
                    organizationAndTeamData,
                    repository,
                    prNumber,
                });
            metadata.queueEntrySha = queueEntrySha;
            if (queueEntrySha !== queueSha) {
                return done({ carried: false, reason: 'not_in_merge_queue' });
            }

            const pullRequest = await this.codeManagement.getPullRequest(
                {
                    organizationAndTeamData,
                    repository: { id: repositoryId, name: repositoryName },
                    prNumber,
                },
                PlatformType.GITHUB,
            );
            const headSha = pullRequest?.head?.sha;
            if (!headSha) {
                return done({ carried: false, reason: 'pr_lookup_failed' });
            }
            metadata.headSha = headSha;

            const run =
                await this.githubChecksService.findLatestCompletedCheckRun({
                    organizationAndTeamData,
                    repository,
                    headSha,
                    name: KODY_CHECK_RUN_NAME,
                });
            if (!run) {
                return done({ carried: false, reason: 'no_completed_run' });
            }
            metadata.sourceCheckRunId = run.id;

            const checkRunId =
                await this.githubChecksService.createCompletedCheckRun({
                    organizationAndTeamData,
                    repository,
                    headSha: queueSha,
                    name: KODY_CHECK_RUN_NAME,
                    conclusion: run.conclusion,
                    detailsUrl: run.htmlUrl,
                    output: {
                        title: run.title || 'Code Review',
                        summary: `Result of Kody's review of PR #${prNumber} at \`${headSha.slice(0, 7)}\`, carried to this merge queue commit. No new review ran.`,
                    },
                });
            metadata.checkRunId = checkRunId;

            return done({ carried: true, conclusion: run.conclusion });
        } catch (error) {
            done({ carried: false, reason: 'api_error' }, error);

            // A rate limit is retried by the webhook job after the reset;
            // any other GitHub error would be marked permanent anyway.
            if (isRateLimitError(classifyGitHubError(error))) {
                throw error;
            }

            return { carried: false, reason: 'api_error' };
        }
    }
}
