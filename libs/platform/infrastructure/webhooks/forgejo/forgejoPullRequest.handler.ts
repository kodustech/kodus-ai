import { createLogger } from '@kodus/flow';
import { EnqueueAstGraphUpdateOnMergedUseCase } from '@libs/code-review/application/use-cases/enqueue-ast-graph-update-on-merged.use-case';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import {
    hasReviewMarker,
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
    WebhookForgejoCommentAction,
    WebhookForgejoEvent,
    WebhookForgejoHookIssueAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-forgejo.type';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
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
import { CodeManagementService } from '../../adapters/services/codeManagement.service';

/**
 * Handler for Forgejo/Gitea webhook events.
 * Processes both pull request and comment events.
 */
@Injectable()
export class ForgejoPullRequestHandler implements IWebhookEventHandler {
    private readonly logger = createLogger(ForgejoPullRequestHandler.name);

    constructor(
        private readonly savePullRequestUseCase: SavePullRequestUseCase,
        private readonly webhookContextService: WebhookContextService,
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

    public canHandle(params: IWebhookEventParams): boolean {
        if (params.platformType !== PlatformType.FORGEJO) {
            return false;
        }

        const supportedEvents: string[] = [
            WebhookForgejoEvent.PULL_REQUEST,
            WebhookForgejoEvent.ISSUE_COMMENT,
            WebhookForgejoEvent.PULL_REQUEST_REVIEW_COMMENT,
        ];

        if (!supportedEvents.includes(params.event)) {
            return false;
        }

        if (params.event === WebhookForgejoEvent.PULL_REQUEST) {
            const allowedActions = [
                WebhookForgejoHookIssueAction.OPENED,
                WebhookForgejoHookIssueAction.SYNCHRONIZED,
                WebhookForgejoHookIssueAction.CLOSED,
                WebhookForgejoHookIssueAction.REOPENED,
            ] as const;

            return allowedActions.includes(params.payload?.action);
        }

        return true;
    }

    public async execute(params: IWebhookEventParams): Promise<void> {
        const { event } = params;

        switch (event) {
            case WebhookForgejoEvent.PULL_REQUEST:
                await this.handlePullRequest(params);
                break;
            case WebhookForgejoEvent.ISSUE_COMMENT:
            case WebhookForgejoEvent.PULL_REQUEST_REVIEW_COMMENT:
                await this.handleComment(params);
                break;
            default:
                this.logger.warn({
                    message: `Unsupported Forgejo event: ${event}`,
                    context: ForgejoPullRequestHandler.name,
                });
                return;
        }
    }

    private async handlePullRequest(
        params: IWebhookEventParams,
    ): Promise<void> {
        // TODO: swap to using typed payload but Partial<Repository> is typed as string instead of int
        // const payload = params.payload as IWebhookForgejoPullRequestEvent;
        // const event = params.event;
        const { payload, event } = params;

        const prNumber = payload?.pull_request?.number || payload?.number;
        const prUrl = payload?.pull_request?.html_url;

        this.logger.log({
            context: ForgejoPullRequestHandler.name,
            serviceName: ForgejoPullRequestHandler.name,
            metadata: { prNumber, prUrl, action: payload?.action },
            message: `Processing Forgejo 'pull_request' event for PR #${prNumber} (${prUrl || 'URL not found'})`,
        });

        const repository = {
            id: String(payload?.repository?.id),
            name: payload?.repository?.full_name,
        };

        const context = await this.webhookContextService.getContext(
            PlatformType.FORGEJO,
            String(payload?.repository?.id),
        );

        // If no active automation found, complete the webhook processing immediately
        if (!context?.organizationAndTeamData) {
            this.logger.log({
                message: `No active automation found for repository, completing webhook processing`,
                context: ForgejoPullRequestHandler.name,
                metadata: {
                    prNumber,
                    repositoryId: String(payload?.repository?.id),
                    repositoryName: repository.name,
                },
            });
            return;
        }

        try {
            await this.savePullRequestUseCase.execute(params);

            if (this.enqueueCodeReviewJobUseCase) {
                this.enqueueCodeReviewJobUseCase
                    .execute({
                        codeManagementPayload: payload,
                        event: event,
                        platformType: PlatformType.FORGEJO,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        correlationId: params.correlationId,
                        teamAutomationId: context.teamAutomationId,
                    })
                    .then((jobId) => {
                        this.logger.log({
                            message:
                                'Code review job enqueued for asynchronous processing',
                            context: ForgejoPullRequestHandler.name,
                            metadata: {
                                jobId,
                                prNumber,
                                repositoryId: repository.id,
                                ...context,
                            },
                        });
                    })
                    .catch((error) => {
                        this.logger.error({
                            message: 'Failed to enqueue code review job',
                            context: ForgejoPullRequestHandler.name,
                            error,
                            metadata: {
                                prNumber,
                                repositoryId: repository.id,
                            },
                        });
                    });
            }

            if (
                payload?.action === WebhookForgejoHookIssueAction.SYNCHRONIZED
            ) {
                this.enqueueImplementationCheckUseCase
                    .execute({
                        payload: payload,
                        event: event,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        platformType: PlatformType.FORGEJO,
                        pullRequestNumber: payload?.pull_request?.number,
                        commitSha: payload?.pull_request?.head?.sha,
                        trigger: payload?.action,
                    })
                    .catch((e) => {
                        this.logger.error({
                            message: 'Failed to enqueue implementation check',
                            context: ForgejoPullRequestHandler.name,
                            error: e,
                            metadata: {
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                                repository,
                                pullRequestNumber:
                                    payload?.pull_request?.number,
                            },
                        });
                    });
            }

            if (payload?.action === WebhookForgejoHookIssueAction.CLOSED) {
                this.generateIssuesFromPrClosedUseCase.execute(params);

                // Durable sandbox invalidation via outbox (SBX-05).
                // Written in the same DB transaction context so it survives worker crashes.
                const prKey = `${context.organizationAndTeamData.organizationId}:${repository.id}:${payload?.pull_request?.number}`;
                this.outboxRepository.create({
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
                        context: ForgejoPullRequestHandler.name,
                        error: err instanceof Error ? err : undefined,
                        metadata: { prKey },
                    });
                });

                // TODO(SBX-05): force-push not surfaced by this platform's webhook payload — add when available.

                // If merged into default branch, trigger Kody Rules sync for main
                const merged = payload?.pull_request?.merged === true;
                const baseRef = payload?.pull_request?.base?.ref;

                let changedFiles:
                    | Array<{
                          filename: string;
                          previous_filename?: string;
                          status: string;
                      }>
                    | undefined;

                if (merged && baseRef) {
                    try {
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
                                        prNumber: payload?.pull_request?.number,
                                    },
                                );

                            this.enqueueAstGraphUpdateOnMergedUseCase
                                ?.execute({
                                    prNumber: payload?.pull_request?.number,
                                    repoExternalId: repository.id,
                                    repoName: repository.name,
                                    platform: PlatformType.FORGEJO,
                                    baseBranch: baseRef,
                                    newSha:
                                        payload?.pull_request
                                            ?.merge_commit_sha,
                                    organizationAndTeamData:
                                        context.organizationAndTeamData,
                                })
                                .catch((e) => {
                                    this.logger.warn({
                                        message: `[AST-GRAPH] Failed to enqueue graph update after PR merge`,
                                        context: ForgejoPullRequestHandler.name,
                                        error: e,
                                    });
                                });
                        }
                    } catch (e) {
                        this.logger.error({
                            message: 'Failed to sync Kody Rules after PR merge',
                            context: ForgejoPullRequestHandler.name,
                            error: e,
                            metadata: {
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                                repository,
                                pullRequestNumber:
                                    payload?.pull_request?.number,
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
                            payload?.pull_request?.number,
                            changedFiles || [],
                            merged,
                        ),
                    );
                }
            }

            return;
        } catch (error) {
            this.logger.error({
                context: ForgejoPullRequestHandler.name,
                serviceName: ForgejoPullRequestHandler.name,
                metadata: {
                    prNumber,
                    prUrl,
                    ...context,
                },
                message: `Error processing Forgejo pull request #${prNumber}: ${error.message}`,
                error,
            });
            throw error;
        }
    }

    /**
     * Process comment events from Forgejo
     */
    private async handleComment(params: IWebhookEventParams): Promise<void> {
        // TODO: swap to using typed payload but Partial<Repository> is typed as string instead of int
        // const payload = params.payload as IWebhookForgejoIssueCommentEvent;
        // const event = params.event;
        const { payload, event } = params;

        const prNumber = payload?.pull_request?.id;

        try {
            // Extract comment data
            const mappedPlatform = getMappedPlatform(PlatformType.FORGEJO);

            if (!mappedPlatform) {
                this.logger.error({
                    message: 'Could not get mapped platform for Forgejo.',
                    serviceName: ForgejoPullRequestHandler.name,
                    metadata: {
                        prNumber,
                    },
                    context: ForgejoPullRequestHandler.name,
                });
                return;
            }

            const comment = mappedPlatform.mapComment({ payload });

            if (
                !comment ||
                !comment.body ||
                payload?.action === WebhookForgejoCommentAction.DELETED
            ) {
                this.logger.debug({
                    message:
                        'Comment body empty or action is deleted, skipping.',
                    serviceName: ForgejoPullRequestHandler.name,
                    metadata: {
                        prNumber,
                    },
                    context: ForgejoPullRequestHandler.name,
                });
                return;
            }

            const isStartCommand = isReviewCommand(comment.body);
            const isForceCommand = isForceReviewCommand(comment.body);
            const hasMarker = hasReviewMarker(comment.body);

            const pullRequest = mappedPlatform.mapPullRequest({ payload });

            if (isStartCommand && !hasMarker) {
                this.logger.log({
                    message: `@kody start command detected in Forgejo comment for PR#${pullRequest?.number}`,
                    serviceName: ForgejoPullRequestHandler.name,
                    metadata: {
                        prNumber,
                    },
                    context: ForgejoPullRequestHandler.name,
                });

                let pullRequestData = null;
                if (
                    payload?.pull_request &&
                    payload?.issue &&
                    payload?.issue?.number
                ) {
                    const repository = {
                        id: String(payload?.repository?.id),
                        name: payload?.repository?.full_name,
                    };

                    const userGitId = payload?.sender?.id?.toString();

                    const context = await this.webhookContextService.getContext(
                        PlatformType.FORGEJO,
                        String(repository.id),
                    );

                    if (!context?.organizationAndTeamData) {
                        this.logger.warn({
                            message: `No active code review found for PR #${payload.issue.number} via command`,
                            context: ForgejoPullRequestHandler.name,
                            metadata: {
                                repository,
                                prNumber: payload.issue.number,
                                userGitId,
                            },
                        });
                        return;
                    }

                    if (context?.organizationAndTeamData) {
                        const data = await this.codeManagement.getPullRequest({
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            repository,
                            prNumber: payload.issue.number,
                        });

                        if (!data) {
                            this.logger.error({
                                message: `Could not fetch pull request details for PR#${payload.issue.number} in repository ${repository.name}`,
                                serviceName: ForgejoPullRequestHandler.name,
                                metadata: {
                                    prNumber,
                                    repository,
                                },
                                context: ForgejoPullRequestHandler.name,
                            });
                            return;
                        }

                        pullRequestData = {
                            ...data,
                            pull_request: {
                                ...data,
                                repository: {
                                    id: repository.id,
                                    name: repository.name,
                                },
                                head: {
                                    ref: data?.head?.ref,
                                    sha: data?.head?.sha,
                                    repo: {
                                        fullName: data?.head?.repo?.fullName,
                                    },
                                },
                                base: {
                                    ref: data?.base?.ref,
                                    sha: data?.base?.sha,
                                    repo: {
                                        fullName: data?.base?.repo?.fullName,
                                        defaultBranch:
                                            data?.base?.repo?.defaultBranch,
                                    },
                                },
                                title: data?.title,
                                body: data?.body,
                                user: {
                                    id: data?.user?.id,
                                    login: data?.user?.login,
                                    name: data?.user?.name,
                                },
                                isDraft: data?.isDraft ?? false,
                            },
                        };
                    }

                    const updatedParams = {
                        ...params,
                        payload: {
                            ...payload,
                            action: 'synchronize',
                            origin: isForceCommand ? 'command-force' : 'command',
                            triggerCommentId: comment?.id,
                            pull_request:
                                pullRequestData ||
                                pullRequest ||
                                payload?.pull_request,
                        },
                    };

                    await this.savePullRequestUseCase.execute(updatedParams);

                    if (
                        this.enqueueCodeReviewJobUseCase &&
                        context?.organizationAndTeamData
                    ) {
                        const jobId =
                            await this.enqueueCodeReviewJobUseCase.execute({
                                codeManagementPayload: updatedParams.payload,
                                event: event,
                                platformType: PlatformType.FORGEJO,
                                organizationAndTeamData:
                                    context?.organizationAndTeamData,
                                teamAutomationId: context.teamAutomationId,
                                correlationId: params.correlationId,
                            });

                        this.logger.log({
                            message:
                                'Code review job enqueued from command for asynchronous processing',
                            context: ForgejoPullRequestHandler.name,
                            metadata: {
                                jobId,
                                prNumber,
                            },
                        });
                    }
                }
                return;
            }

            if (
                (event === 'pull_request_review_comment' ||
                    event === 'issue_comment') &&
                !hasMarker &&
                !isStartCommand &&
                isKodyMentionNonReview(comment.body)
            ) {
                this.chatWithKodyFromGitUseCase.execute(params);
                return;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error processing Forgejo pull request comment',
                serviceName: ForgejoPullRequestHandler.name,
                metadata: {
                    prNumber,
                },
                context: ForgejoPullRequestHandler.name,
                error,
            });
        }
    }
}
