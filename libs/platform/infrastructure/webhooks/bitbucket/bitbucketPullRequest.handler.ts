import { createLogger } from '@kodus/flow';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import {
    SANDBOX_INVALIDATE_ROUTING_KEY,
    SandboxInvalidatePayload,
} from '@libs/sandbox/domain/events/sandbox-invalidate.event';

import { EnqueueAstGraphUpdateOnMergedUseCase } from '@libs/code-review/application/use-cases/enqueue-ast-graph-update-on-merged.use-case';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import {
    isForceReviewCommand,
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
import {
    IWebhookBitbucketDataCenterPullRequestEvent,
    IWebhookBitbucketPullRequestEvent,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
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
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outboxRepository: IOutboxMessageRepository,
        @Optional()
        private readonly enqueueAstGraphUpdateOnMergedUseCase?: EnqueueAstGraphUpdateOnMergedUseCase,
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
                // cloud events
                'pullrequest:created',
                'pullrequest:updated',
                'pullrequest:fulfilled',
                'pullrequest:rejected',
                'pullrequest:comment_created',

                // data center events
                'pr:opened',
                'pr:modified',
                'pr:reviewer:updated',
                'pr:comment:added',
                'pr:merged',
                'pr:declined',
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
            case 'pr:comment:added':
                await this.handleComment(params);
                break;
            case 'pullrequest:created':
            case 'pr:opened':
            case 'pullrequest:updated':
            case 'pr:modified':
            case 'pullrequest:fulfilled':
            case 'pr:merged':
            case 'pullrequest:rejected':
            case 'pr:declined':
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
        const isDataCenterEvent = payload?.isDataCenterEvent ?? false;

        const mappedPlatform = getMappedPlatform(PlatformType.BITBUCKET);
        const mappedPR = mappedPlatform?.mapPullRequest({
            payload,
        });
        const mappedRepo = mappedPlatform?.mapRepository({
            payload,
        });

        const prId = mappedPR?.number ?? payload?.pullrequest?.id;
        const prUrl =
            mappedPR?.url ??
            (isDataCenterEvent ? '' : payload?.pullrequest?.links?.html?.href);

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
            id: (mappedRepo?.id ?? payload?.repository?.uuid)?.replace(
                /[{}]/g,
                '',
            ),
            name: mappedRepo?.name ?? payload?.repository?.name,
            fullName: mappedRepo?.fullName ?? payload?.repository?.full_name,
        };

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

                const action =
                    mappedPlatform?.mapAction({ payload, event }) ?? event;
                const isOpened =
                    action === 'OPENED' ||
                    event === 'pullrequest:created' ||
                    event === 'pr:opened';
                const isUpdated =
                    action === 'UPDATED' ||
                    event === 'pullrequest:updated' ||
                    event === 'pr:modified';

                // For created/updated events, also trigger automation
                if (isOpened || isUpdated) {
                    if (isUpdated) {
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
                                    pullRequestNumber: prId,
                                    commitSha: isDataCenterEvent
                                        ? payload?.pullrequest?.fromRef
                                              ?.latestCommit
                                        : payload?.pullrequest?.source?.commit
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
                                            pullRequestNumber: prId,
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

                    // Durable sandbox invalidation via outbox (SBX-05).
                    const prKey = `${context.organizationAndTeamData.organizationId}:${repository.id}:${payload?.pullrequest?.id}`;
                    await this.outboxRepository.create({
                        jobId: undefined,
                        exchange: 'sandbox.events',
                        routingKey: SANDBOX_INVALIDATE_ROUTING_KEY,
                        payload: {
                            prKey,
                            reason: 'pr_closed',
                        } satisfies SandboxInvalidatePayload,
                    }).catch((err) => {
                        this.logger.warn({
                            message: '[SBX-05] Failed to write sandbox invalidation outbox message',
                            context: BitbucketPullRequestHandler.name,
                            error: err instanceof Error ? err : undefined,
                            metadata: { prKey },
                        });
                    });

                    // TODO(SBX-05): Bitbucket 'pullrequest:updated' events do not distinguish
                    // force-push from regular push — no force-push outbox write is added here.

                    const merged = payload?.pullrequest?.state === 'MERGED';

                    let changedFiles:
                        | Array<{
                              filename: string;
                              previous_filename?: string;
                              status: string;
                          }>
                        | undefined;

                    if (merged) {
                        try {
                            if (context.organizationAndTeamData) {
                                const baseRef =
                                    mappedPR?.base?.ref ??
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
                                    changedFiles = undefined;
                                } else {
                                    changedFiles =
                                        await this.codeManagement.getFilesByPullRequestId(
                                            {
                                                organizationAndTeamData:
                                                    context.organizationAndTeamData,
                                                repository: {
                                                    id: repository.id,
                                                    name: repository.name,
                                                },
                                                prNumber: prId,
                                            },
                                        );

                                    this.enqueueAstGraphUpdateOnMergedUseCase
                                        ?.execute({
                                            prNumber: prId,
                                            repoExternalId: repository.id,
                                            repoName: repository.name,
                                            platform: PlatformType.BITBUCKET,
                                            baseBranch: baseRef,
                                            newSha: isDataCenterEvent
                                                ? payload?.pullrequest?.toRef
                                                      ?.latestCommit
                                                : payload?.pullrequest
                                                      ?.merge_commit?.hash,
                                            organizationAndTeamData:
                                                context.organizationAndTeamData,
                                        })
                                        .catch((e) => {
                                            this.logger.warn({
                                                message: `[AST-GRAPH] Failed to enqueue graph update after PR merge`,
                                                context:
                                                    BitbucketPullRequestHandler.name,
                                                error: e,
                                            });
                                        });
                                }
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
                                    pullRequestNumber: prId,
                                },
                            });
                        }
                    }

                    if (context.organizationAndTeamData) {
                        this.eventEmitter.emit(
                            'pull-request.closed',
                            new PullRequestClosedEvent(
                                context.organizationAndTeamData,
                                repository,
                                prId,
                                changedFiles || [],
                                merged,
                            ),
                        );
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
        const isDataCenterEvent = payload?.isDataCenterEvent ?? false;

        // Initialize mapper early
        const mappedPlatform = getMappedPlatform(PlatformType.BITBUCKET);

        if (!mappedPlatform) {
            this.logger.error({
                message: 'Could not get mapped platform for Bitbucket.',
                serviceName: BitbucketPullRequestHandler.name,
                metadata: {
                    prId: payload?.pullrequest?.id,
                },
                context: BitbucketPullRequestHandler.name,
            });
            return;
        }

        // Use mapper to extract PR and Repository data safely
        const mappedPR = mappedPlatform.mapPullRequest({
            payload,
        });
        const mappedRepo = mappedPlatform.mapRepository({
            payload,
        });

        // Safely extract PR ID
        const prId = mappedPR?.number ?? payload?.pullrequest?.id;

        // Extract and format Repository ID/Name with strict Cloud fallbacks to guarantee 0% regression
        const rawRepoId =
            mappedRepo?.id ??
            (isDataCenterEvent
                ? payload?.pullrequest?.toRef?.repository?.id?.toString()
                : payload?.repository?.uuid);

        const repository = {
            id: rawRepoId?.replace(/[{}]/g, ''),
            name:
                mappedRepo?.name ??
                (isDataCenterEvent
                    ? payload?.pullrequest?.toRef?.repository?.name
                    : payload?.repository?.name),
        };

        const context = await this.webhookContextService.getContext(
            PlatformType.BITBUCKET,
            String(repository.id),
        );

        try {
            // Map the comment (handles both DC and Cloud via your updated mapper)
            const comment = mappedPlatform.mapComment({
                payload,
            });

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
            const isForceCommand = isForceReviewCommand(comment.body);

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
                        origin: isForceCommand ? 'command-force' : 'command',
                        triggerCommentId: comment?.id,
                    },
                };

                await this.savePullRequestUseCase.execute(updatedParams);
                if (context?.organizationAndTeamData) {
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

        const pullrequest = payload.pullrequest;
        const mappedPlatform = getMappedPlatform(PlatformType.BITBUCKET);
        const mappedRepo = mappedPlatform?.mapRepository({
            payload,
        });

        const repoId = (
            mappedRepo?.id ?? (payload as any)?.repository?.uuid
        )?.replace(/[{}]/g, '');
        const repoName = mappedRepo?.name ?? (payload as any)?.repository?.name;

        const context = await this.webhookContextService.getContext(
            platformType,
            repoId,
        );

        const organizationAndTeamData = context?.organizationAndTeamData;

        if (!organizationAndTeamData) {
            this.logger.debug({
                message: `No integration configs found for repository ${repoName} (${repoId})`,
                context: BitbucketPullRequestHandler.name,
                serviceName: BitbucketPullRequestHandler.name,
                metadata: {
                    repositoryName: repoName,
                    repositoryId: repoId,
                    platformType,
                    prNumber: pullrequest.id,
                },
            });
            return false;
        }

        const action = mappedPlatform?.mapAction({ payload, event }) ?? event;
        const isUpdated =
            action === 'UPDATED' ||
            event === 'pullrequest:updated' ||
            event === 'pr:modified';

        if (isUpdated) {
            try {
                const pullRequestCommits =
                    await this.codeManagement.getCommitsForPullRequestForCodeReview(
                        {
                            organizationAndTeamData,
                            repository: {
                                id: repoId,
                                name: repoName,
                            },
                            prNumber: pullrequest.id,
                        },
                    );

                const storedPR =
                    await this.pullRequestsService.findByNumberAndRepositoryName(
                        pullrequest.id,
                        repoName,
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
    ): event is
        | IWebhookBitbucketPullRequestEvent
        | IWebhookBitbucketDataCenterPullRequestEvent {
        const isBitbucketDataCenterEvent = event?.isDataCenterEvent === true;

        const pullRequest = event?.pullrequest;
        const actor = event?.actor;
        const repository = event?.repository;
        const areUndefined =
            pullRequest === undefined ||
            actor === undefined ||
            (!isBitbucketDataCenterEvent && repository === undefined);

        if (areUndefined) {
            return false;
        }

        return true;
    }
}
