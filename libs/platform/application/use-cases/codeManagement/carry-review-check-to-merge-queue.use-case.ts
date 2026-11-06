import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { classifyGitHubError } from '@libs/core/workflow/domain/errors/classify-github-error';
import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { KODY_CHECK_RUN_NAME } from '@libs/core/infrastructure/pipeline/services/pipeline-checks.service';
import { createLogger } from '@libs/core/log/logger';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';
import { IWebhookEventParams } from '@libs/platform/domain/platformIntegrations/interfaces/webhook-event-handler.interface';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import {
    isMergeQueuePush,
    parseMergeQueueRef,
} from '@libs/platform/infrastructure/webhooks/github/merge-queue-ref';
import { Injectable } from '@nestjs/common';

type MergeQueueCheckTarget = Pick<
    Parameters<GithubChecksService['createCompletedCheckRun']>[0],
    'organizationAndTeamData' | 'repository' | 'headSha' | 'name'
>;

export type CarryReviewCheckResult =
    | { carried: true; conclusion: string }
    | {
          carried: false;
          reason:
              | 'not_merge_queue_push'
              | 'no_context'
              | 'token_auth'
              | 'not_in_merge_queue';
      }
    | {
          carried: false;
          reason: 'no_completed_run' | 'api_error';
          /** Whether a failure check explaining the reason was posted. */
          failurePosted: boolean;
      };

/**
 * GitHub's merge queue waits for every required check on the commit it
 * builds for a queued PR. Kody reports on the PR head only, so this copies
 * the PR head's newest finished Kody result onto the queue commit. No review
 * runs here. When there is nothing to copy, a verified queue commit gets a
 * failure with the reason, so the queue drops the PR at once instead of
 * waiting for its timeout.
 */
@Injectable()
export class CarryReviewCheckToMergeQueueUseCase {
    private readonly logger = createLogger(
        CarryReviewCheckToMergeQueueUseCase.name,
    );

    constructor(
        private readonly webhookContextService: WebhookContextService,
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

        // Set once the queue is known to have built this commit for the PR.
        let target: MergeQueueCheckTarget | undefined;
        let carrying = false;

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

            // A personal access token has no Checks API: nothing to read
            // or post, so skip the queue lookup too.
            if (
                !(await this.githubChecksService.isChecksApiAvailable(
                    organizationAndTeamData,
                ))
            ) {
                return done({ carried: false, reason: 'token_auth' });
            }

            const repository = { owner, name: repositoryName };

            const entry = await this.githubChecksService.findMergeQueueEntry({
                organizationAndTeamData,
                repository,
                prNumber,
            });
            metadata.queueEntrySha = entry?.queueSha ?? null;
            if (entry?.queueSha !== queueSha) {
                return done({ carried: false, reason: 'not_in_merge_queue' });
            }

            const { headSha } = entry;
            metadata.headSha = headSha;
            target = {
                organizationAndTeamData,
                repository,
                headSha: queueSha,
                name: KODY_CHECK_RUN_NAME,
            };

            const run =
                await this.githubChecksService.findLatestCompletedCheckRun({
                    organizationAndTeamData,
                    repository,
                    headSha,
                    name: KODY_CHECK_RUN_NAME,
                });
            if (!run) {
                const failurePosted = await this.postFailure(
                    target,
                    prNumber,
                    'No finished Kody review',
                    `PR #${prNumber}'s latest commit (\`${headSha.slice(0, 7)}\`) has no finished Kody review, so there is no result for this merge queue commit. Comment \`@kody start-review\` on the PR, wait for the review to finish, then add the PR to the queue again.`,
                );
                return done({
                    carried: false,
                    reason: 'no_completed_run',
                    failurePosted,
                });
            }
            metadata.sourceCheckRunId = run.id;

            carrying = true;
            const checkRunId =
                await this.githubChecksService.createCompletedCheckRun({
                    ...target,
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
            // A rate limit is retried by the webhook job after the reset;
            // any other GitHub error would be marked permanent anyway.
            if (isRateLimitError(classifyGitHubError(error))) {
                done(
                    {
                        carried: false,
                        reason: 'api_error',
                        failurePosted: false,
                    },
                    error,
                );
                throw error;
            }

            // Only a commit the queue is known to have built gets a check,
            // and not when posting the carried result is what failed.
            const failurePosted =
                target && !carrying
                    ? await this.postFailure(
                          target,
                          prNumber,
                          "Could not carry Kody's review",
                          `Kody could not read the result of its review of PR #${prNumber} from GitHub. Add the PR to the queue again; if this repeats, comment \`@kody start-review\` on the PR.`,
                      )
                    : false;

            return done(
                { carried: false, reason: 'api_error', failurePosted },
                error,
            );
        }
    }

    /**
     * Best effort: on failure the queue waits for its timeout, as before.
     * A rate limit is rethrown so the webhook job retries.
     */
    private async postFailure(
        target: MergeQueueCheckTarget,
        prNumber: number,
        title: string,
        summary: string,
    ): Promise<boolean> {
        try {
            const checkRunId =
                await this.githubChecksService.createCompletedCheckRun({
                    ...target,
                    conclusion: 'failure',
                    output: { title, summary },
                });
            return checkRunId !== null;
        } catch (error) {
            if (isRateLimitError(classifyGitHubError(error))) {
                throw error;
            }

            this.logger.warn({
                message: 'Could not post the merge queue failure check',
                context: CarryReviewCheckToMergeQueueUseCase.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    organizationId:
                        target.organizationAndTeamData.organizationId,
                    teamId: target.organizationAndTeamData.teamId,
                    repositoryName: target.repository.name,
                    prNumber,
                    queueSha: target.headSha,
                },
            });
            return false;
        }
    }
}
