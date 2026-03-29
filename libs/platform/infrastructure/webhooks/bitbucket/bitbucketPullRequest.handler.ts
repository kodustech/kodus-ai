import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import {
    isKodyMentionNonReview,
    isReviewCommand,
} from '@libs/common/utils/codeManagement/codeCommentMarkers';
import { getMappedPlatform } from '@libs/common/utils/webhooks';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import { EnqueueCodeReviewJobUseCase } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { GenerateIssuesFromPrClosedUseCase } from '@libs/issues/application/use-cases/generate-issues-from-pr-closed.use-case';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';
import { ChatWithKodyFromGitUseCase } from '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case';
import {
    IWebhookEventHandler,
    IWebhookEventParams,
} from '@libs/platform/domain/platformIntegrations/interfaces/webhook-event-handler.interface';
import { IWebhookBitbucketPullRequestEvent } from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { CodeManagementService } from '../../adapters/services/codeManagement.service';

/**
 * Handler for Bitbucket webhook events.
 * Processes both pull request and comment events.
 */
@Injectable()
export class BitbucketPullRequestHandler implements IWebhookEventHandler {
    private readonly logger = createLogger(BitbucketPullRequestHandler.name);
    constructor(
        private readonly webhookContextService: WebhookContextService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
        private readonly savePullRequestUseCase: SavePullRequestUseCase,
        private readonly chatWithKodyFromGitUseCase: ChatWithKodyFromGitUseCase,
        private readonly codeManagement: CodeManagementService,
        private readonly generateIssuesFromPrClosedUseCase: GenerateIssuesFromPrClosedUseCase,
        private readonly eventEmitter: EventEmitter2,
        private readonly enqueueCodeReviewJobUseCase: EnqueueCodeReviewJobUseCase,
        private readonly enqueueImplementationCheckUseCase: EnqueueImplementationCheckUseCase,
    ) {}

    /**
     * Checks if this handler can process the given webhook event.
     * @param params The webhook event parameters.
     * @returns True if this handler can process the event, false otherwise.
     */
    public canHandle(params: IWebhookEventParams): boolean {
        return (
            params.platformType === PlatformType.BITBUCKET &&
            [
                'pullrequest:created',
                'pullrequest:updated',
                'pullrequest:fulfilled',
                'pullrequest:rejected',
                'pullrequest:comment_created',
            ].includes(params.event)
        );
    }

    /**
     * Processes Bitbucket webhook events.
     * @param params The webhook event parameters.
     */
    public async execute(params: IWebhookEventParams): Promise<void> {
        const { event } = params;

        switch (event) {
            case 'pullrequest:comment_created':
                await this.handleComment(params);
                break;
            case 'pullrequest:created':
            case 'pullrequest:updated':
            case 'pullrequest:fulfilled':
            case 'pullrequest:rejected':
                await this.handlePullRequest(params);
                break;
            default:
                this.logger.warn({
                    message: `Unsupported Bitbucket event: ${event}`,
                    serviceName: BitbucketPullRequestHandler.name,
                    context: BitbucketPullRequestHandler.name,
                    metadata: {
                        event,
                    },
                });
        }
    }

    private async handlePullRequest(
        params: IWebhookEventParams,
    ): Promise<void> {
        const { payload, event } = params;
        const prId = payload?.pullrequest?.id;
        const prUrl = payload?.pullrequest?.links?.html?.href;

        this.logger.log({
            context: BitbucketPullRequestHandler.name,
            serviceName: BitbucketPullRequestHandler.name,
            metadata: {
                prId,
                prUrl,
                event,
            },
            message: `Processing Bitbucket '${event}' event for PR #${prId} (${
                prUrl || 'URL not found'
            })`,
        });

        const repository = {
            id: payload?.repository?.uuid?.replace(/[{}]/g, ''),
            name: payload?.repository?.name,
            fullName: payload?.repository?.full_name,
        } as any;

        const context = await this.webhookContextService.getContext(
            PlatformType.BITBUCKET,
            String(repository.id),
        );

        // If no active automation found, complete the webhook processing immediately
        if (!context?.organizationAndTeamData) {
            this.logger.log({
                message: `No active automation found for repository, completing webhook processing`,
                context: BitbucketPullRequestHandler.name,
                metadata: {
                    prId,
                    repositoryId: repository.id,
                    repositoryName: repository.name,
                },
            });
            return;
        }

        try {
            // Check if we should trigger code review based on the PR event
            const shouldTrigger = await this.shouldTriggerCodeReview(params);

            if (shouldTrigger) {
                await this.savePullRequestUseCase.execute(params);

                // For created/updated events, also trigger automation
                if (
                    event === 'pullrequest:created' ||
                    event === 'pullrequest:updated'
                ) {
                    if (event === 'pullrequest:updated') {
                        if (context.organizationAndTeamData) {
                            this.enqueueImplementationCheckUseCase
                                .execute({
                                    payload: payload,
                                    event: event,
                                    platformType: PlatformType.BITBUCKET,
                                    organizationAndTeamData:
                                        context.organizationAndTeamData,
                                    repository: {
                                        id: repository.id,
                                        name: repository.name,
                                    },
                                    pullRequestNumber: payload?.pullrequest?.id,
                                    commitSha:
                                        payload?.pullrequest?.source?.commit
                                            ?.hash,
                                    trigger: 'synchronize',
                                })
                                .catch((e) => {
                                    this.logger.error({
                                        message:
                                            'Failed to enqueue implementation check',
                                        context:
                                            BitbucketPullRequestHandler.name,
                                        error: e,
                                        metadata: {
                                            repository,
                                            pullRequestNumber:
                                                payload?.pullrequest?.id,
                                            organizationAndTeamData:
                                                context.organizationAndTeamData,
                                        },
                                    });
                                });
                        }
                    }

                    if (
                        this.enqueueCodeReviewJobUseCase &&
                        context.organizationAndTeamData
                    ) {
                        this.enqueueCodeReviewJobUseCase
                            .execute({
                                codeManagementPayload: params.payload,
                                event: params.event,
                                platformType: PlatformType.BITBUCKET,
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                                correlationId: params.correlationId,
                                teamAutomationId: context.teamAutomationId,
                            })
                            .then((jobId) => {
                                this.logger.log({
                                    message:
                                        'Code review job enqueued for asynchronous processing',
                                    context: BitbucketPullRequestHandler.name,
                                    metadata: {
                                        jobId,
                                        prId,
                                        repositoryId: repository.id,
                                    },
                                });
                            })
                            .catch((error) => {
                                this.logger.error({
                                    message:
                                        'Failed to enqueue code review job',
                                    context: BitbucketPullRequestHandler.name,
                                    error,
                                    metadata: {
                                        prId,
                                        repositoryId: repository.id,
                                        organizationAndTeamData:
                                            context.organizationAndTeamData,
                                    },
                                });
                            });
                    } else {
                        this.logger.log({
                            message:
                                'Skipping code review job enqueue (missing org/team or enqueue use case)',
                            context: BitbucketPullRequestHandler.name,
                            metadata: {
                                ...context,
                                hasOrgAndTeam:
                                    !!context.organizationAndTeamData,
                                prId,
                                repositoryId: repository.id,
                            },
                        });
                    }
                }
            } else {
                // For events that don't trigger code review, just save the state
                const pullRequest =
                    await this.savePullRequestUseCase.execute(params);

                if (pullRequest && pullRequest.status === 'closed') {
                    this.generateIssuesFromPrClosedUseCase.execute(params);

                    const merged = payload?.pullrequest?.state === 'MERGED';

                    if (merged) {
                        try {
                            if (context.organizationAndTeamData) {
                                const baseRef =
                                    payload?.pullrequest?.destination?.branch
                                        ?.name;
                                const defaultBranch =
                                    await this.codeManagement.getDefaultBranch({
                                        organizationAndTeamData:
                                            context.organizationAndTeamData,
                                        repository: {
                                            id: repository.id,
                                            name: repository.name,
                                        },
                                    });
                                if (baseRef !== defaultBranch) {
                                    return;
                                }
                                const changedFiles =
                                    await this.codeManagement.getFilesByPullRequestId(
                                        {
                                            organizationAndTeamData:
                                                context.organizationAndTeamData,
                                            repository: {
                                                id: repository.id,
                                                name: repository.name,
                                            },
                                            prNumber: payload?.pullrequest?.id,
                                        },
                                    );
                                this.eventEmitter.emit(
                                    'pull-request.closed',
                                    new PullRequestClosedEvent(
                                        context.organizationAndTeamData,
                                        repository,
                                        payload?.pullrequest?.id,
                                        changedFiles || [],
                                    ),
                                );
                            }
                        } catch (e) {
                            this.logger.error({
                                message:
                                    'Failed to sync Kody Rules after PR merge',
                                context: BitbucketPullRequestHandler.name,
                                error: e,
                                metadata: {
                                    organizationAndTeamData:
                                        context.organizationAndTeamData,
                                    repository,
                                    pullRequestNumber: payload?.pullrequest?.id,
                                },
                            });
                        }
                    }
                }
            }
        } catch (error) {
            this.logger.error({
                context: BitbucketPullRequestHandler.name,
                serviceName: BitbucketPullRequestHandler.name,
                message: `Error processing Bitbucket pull request #${prId}: ${error.message}`,
                metadata: {
                    prId,
                    prUrl,
                    event,
                },
                error,
            });
            throw error;
        }
    }

    private async handleComment(params: IWebhookEventParams): Promise<void> {
        const { payload } = params;
        const prId = payload?.pullrequest?.id;
        const repository = {
            id: payload?.repository?.uuid?.replace(/[{}]/g, ''),
            name: payload?.repository?.name,
        } as any;

        const context = await this.webhookContextService.getContext(
            PlatformType.BITBUCKET,
            String(repository.id),
        );

        try {
            const mappedPlatform = getMappedPlatform(PlatformType.BITBUCKET);

            if (!mappedPlatform) {
                this.logger.error({
                    message: 'Could not get mapped platform for Bitbucket.',
                    serviceName: BitbucketPullRequestHandler.name,
                    metadata: {
                        prId,
                    },
                    context: BitbucketPullRequestHandler.name,
                });
                return;
            }

            const comment = mappedPlatform.mapComment({ payload });

            if (!comment || !comment.body || payload?.action === 'deleted') {
                this.logger.debug({
                    message:
                        'Comment body empty or action is deleted, skipping.',
                    serviceName: BitbucketPullRequestHandler.name,
                    metadata: {
                        prId,
                    },
                    context: BitbucketPullRequestHandler.name,
                });
                return;
            }

            const isStartCommand = isReviewCommand(comment.body);

            // Bitbucket-specific: Verify if the comment is a review marker (emoji or API generated)
            const emojiPattern = /(?:👍|👎)/u;
            const apiGeneratedPattern = /(?:kody code-review)/i;
            const hasMarker =
                emojiPattern.test(comment.body) ||
                apiGeneratedPattern.test(comment.body);

            if (isStartCommand && !hasMarker) {
                this.logger.log({
                    message: `@kody start command detected in Bitbucket comment for PR#${prId}`,
                    serviceName: BitbucketPullRequestHandler.name,
                    metadata: {
                        prId,
                    },
                    context: BitbucketPullRequestHandler.name,
                });

                const updatedParams = {
                    ...params,
                    payload: {
                        ...payload,
                        action: 'synchronize',
                        origin: 'command',
                        triggerCommentId: comment?.id,
                    },
                };

                await this.savePullRequestUseCase.execute(updatedParams);
                if (context.organizationAndTeamData) {
                    await this.enqueueCodeReviewJobUseCase.execute({
                        codeManagementPayload: updatedParams.payload,
                        event: updatedParams.event,
                        platformType: PlatformType.BITBUCKET,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        correlationId: params.correlationId,
                        teamAutomationId: context.teamAutomationId,
                    });
                }
                return;
            }

            if (
                !isStartCommand &&
                !hasMarker &&
                isKodyMentionNonReview(comment.body)
            ) {
                this.chatWithKodyFromGitUseCase.execute(params);
                return;
            }
        } catch (error) {
            this.logger.error({
                context: BitbucketPullRequestHandler.name,
                serviceName: BitbucketPullRequestHandler.name,
                message: `Error processing Bitbucket comment for PR #${prId}: ${error.message}`,
                error,
                metadata: {
                    prId,
                },
            });
            throw error;
        }
    }

    /**
     * Determines if code review should be triggered based on the pull request payload.
     * @param params The webhook event parameters.
     * @returns True if code review should be triggered, false otherwise.
     */
    private async shouldTriggerCodeReview(
        params: IWebhookEventParams,
    ): Promise<boolean> {
        const { event, payload, platformType } = params;

        // Verify if it's a valid pull request event
        if (!this.isBitbucketPullRequestEvent(payload)) {
            return false;
        }

        const { pullrequest, repository } = payload;
        const repoId = repository.uuid.slice(1, repository.uuid.length - 1);

        const context = await this.webhookContextService.getContext(
            platformType,
            repoId,
        );

        const organizationAndTeamData = context?.organizationAndTeamData;

        if (!organizationAndTeamData) {
            this.logger.debug({
                message: `No integration configs found for repository ${repository.name} (${repoId})`,
                context: BitbucketPullRequestHandler.name,
                serviceName: BitbucketPullRequestHandler.name,
                metadata: {
                    repositoryName: repository.name,
                    repositoryId: repoId,
                    platformType,
                    prNumber: pullrequest.id,
                },
            });
            return false;
        }

        if (event === 'pullrequest:updated') {
            try {
                const pullRequestCommits =
                    await this.codeManagement.getCommitsForPullRequestForCodeReview(
                        {
                            organizationAndTeamData,
                            repository: {
                                id: repoId,
                                name: repository.name,
                            },
                            prNumber: pullrequest.id,
                        },
                    );

                const storedPR =
                    await this.pullRequestsService.findByNumberAndRepositoryName(
                        pullrequest.id,
                        repository.name,
                        organizationAndTeamData,
                    );

                const isDraft = pullrequest.draft ?? false;
                const wasDraft = storedPR?.isDraft ?? false;

                if (pullrequest.state === 'OPEN' && wasDraft && !isDraft) {
                    return true;
                }

                if (storedPR && pullrequest.state === 'OPEN') {
                    const prCommit =
                        pullRequestCommits[pullRequestCommits.length - 1];
                    const storedPRCommitHashes = storedPR?.commits?.map(
                        (commit) => commit.sha,
                    );
                    if (storedPRCommitHashes?.includes(prCommit?.sha)) {
                        return false;
                    }
                }
            } catch (error) {
                this.logger.error({
                    message: `Error checking PR commits: ${error.message}`,
                    context: BitbucketPullRequestHandler.name,
                    serviceName: BitbucketPullRequestHandler.name,
                    metadata: {
                        prId: pullrequest.id,
                        event,
                    },
                    error,
                });
                return pullrequest.state === 'OPEN';
            }
        }

        switch (pullrequest.state) {
            case 'OPEN':
                return true;
            case 'MERGED':
                return false;
            case 'DECLINED':
                return false;
            default:
                return false;
        }
    }

    private isBitbucketPullRequestEvent(
        event: any,
    ): event is IWebhookBitbucketPullRequestEvent {
        const pullRequest = event?.pullrequest;
        const actor = event?.actor;
        const repository = event?.repository;
        const areUndefined =
            pullRequest === undefined ||
            actor === undefined ||
            repository === undefined;

        if (areUndefined) {
            return false;
        }

        return true;
    }
}
