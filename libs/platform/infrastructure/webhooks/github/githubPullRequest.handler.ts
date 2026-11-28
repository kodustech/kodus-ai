import { traceparentFor } from '@libs/runtime/telemetry/runtime-telemetry';
import { classifyGitHubError } from '@libs/core/workflow/domain/errors/classify-github-error';
import { reviewCommandAccess } from '@libs/platform/application/services/commenter-access';
import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { createLogger } from '@libs/core/log/logger';
import { EnqueueAstGraphUpdateOnMergedUseCase } from '@libs/code-review/application/use-cases/enqueue-ast-graph-update-on-merged.use-case';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import {
    hasReviewMarker,
    isForceReviewCommand,
    isRuntimeCommand,
    isKodyMentionNonReview,
    isReviewCommand,
    parseReviewDirective,
    requestedReviewModeOf,
    parseCustomAgentCommand,
} from '@libs/common/utils/codeManagement/codeCommentMarkers';
import { isNewThreadReply } from '@libs/common/utils/codeManagement/threadReply';
import {
    getMappedPlatform,
    githubWebhookSource,
} from '@libs/common/utils/webhooks';
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
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CodeManagementService } from '../../adapters/services/codeManagement.service';
import { CarryReviewCheckToMergeQueueUseCase } from '@libs/platform/application/use-cases/codeManagement/carry-review-check-to-merge-queue.use-case';
import { defaultBranchPushOf } from './default-branch-push';
import { isMergeQueuePush } from './merge-queue-ref';
import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import {
    SANDBOX_INVALIDATE_ROUTING_KEY,
    SandboxInvalidatePayload,
} from '@libs/sandbox/domain/events/sandbox-invalidate.event';
import { randomUUID } from 'crypto';
import {
    runtimePushOutboxMessage,
    runtimeTriggerOutboxMessage,
    RuntimePullRequestObservedSchema,
    type RuntimeDefaultBranchPushObserved,
    type RuntimePullRequestObserved,
} from '@libs/runtime/run/run-messages';
import {
    RUNTIME_PULL_REQUEST_GATE_TOKEN,
    type RuntimePullRequestGate,
} from '@libs/runtime-publish/domain/pull-request-observation-gate';
import { SyncAllRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/sync-all-repositories.use-case';
import { isNewRepositoryEvent } from './new-repository-event';
import { requestedReviewerOf } from './review-request';
import type { HostAccount } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

/**
 * Handler for GitHub webhook events.
 * Processes both pull request and comment events.
 */
@Injectable()
export class GitHubPullRequestHandler implements IWebhookEventHandler {
    private readonly logger = createLogger(GitHubPullRequestHandler.name);
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
        private readonly carryReviewCheckToMergeQueueUseCase: CarryReviewCheckToMergeQueueUseCase,
        private readonly syncAllRepositoriesUseCase: SyncAllRepositoriesUseCase,
        @Optional()
        private readonly enqueueAstGraphUpdateOnMergedUseCase?: EnqueueAstGraphUpdateOnMergedUseCase,
        // Provided only where Kody Runtime is on (RuntimePullRequestGateModule);
        // without it no pull request event is written for the Runtime.
        @Optional()
        @Inject(RUNTIME_PULL_REQUEST_GATE_TOKEN)
        private readonly runtimeGate?: RuntimePullRequestGate,
    ) {}

    public canHandle(params: IWebhookEventParams): boolean {
        // Verify if the event is from GitHub
        if (params.platformType !== PlatformType.GITHUB) {
            return false;
        }

        if (isNewRepositoryEvent(params.event, params.payload)) {
            return true;
        }

        // Pushes are handled for merge queue branches, to report Kody's check
        // on the commit the queue tests, and, where the Runtime is on, for the
        // default branch (an environment's setup, R6).
        if (params.event === 'push') {
            return (
                isMergeQueuePush(params.event, params.payload) ||
                (!!this.runtimeGate &&
                    defaultBranchPushOf(params.event, params.payload) !== null)
            );
        }

        // Verify if the event is one of the supported events
        const supportedEvents = [
            'pull_request',
            'issue_comment',
            'pull_request_review_comment',
        ];
        if (!supportedEvents.includes(params.event)) {
            return false;
        }

        // Verify if the event is a pull_request and check the action type
        if (params.event === 'pull_request') {
            // These actions are allowed to be processed by this handler
            const allowedActions = [
                'opened',
                'synchronize',
                'closed',
                'reopened',
                'ready_for_review',
            ];

            // If the action is in the allowed list, we can process it
            return (
                allowedActions.includes(params.payload?.action) ||
                !!requestedReviewerOf(params.event, params.payload)
            );
        }

        // If all checks pass, return true
        return true;
    }

    public async execute(params: IWebhookEventParams): Promise<void> {
        const { event } = params;

        if (isNewRepositoryEvent(event, params.payload)) {
            const installationId = params.payload?.installation?.id;
            if (installationId) {
                await this.syncAllRepositoriesUseCase.syncInstallation(
                    String(installationId),
                );
            }
            return;
        }

        switch (event) {
            case 'pull_request': {
                const requestedReviewer = requestedReviewerOf(
                    event,
                    params.payload,
                );
                if (requestedReviewer) {
                    await this.handleReviewRequested(params, requestedReviewer);
                } else {
                    await this.handlePullRequest(params);
                }
                break;
            }
            case 'issue_comment':
            case 'pull_request_review_comment':
                await this.handleComment(params);
                break;
            case 'push':
                if (isMergeQueuePush(event, params.payload)) {
                    await this.carryReviewCheckToMergeQueueUseCase.execute(
                        params,
                    );
                } else {
                    await this.recordDefaultBranchPushForRuntime(params);
                }
                break;
            default:
                this.logger.warn({
                    message: `Unsupported GitHub event: ${event}`,
                    context: GitHubPullRequestHandler.name,
                });
                return;
        }
    }

    /**
     * "Re-request review" on Kody is `@kody start-review` as a click: it
     * resumes a paused PR, runs a manual-mode review and retries a failed one.
     * GitHub shows that button for user accounts only, so the click exists
     * where Kody reviews as one (a personal access token), not as the App.
     * It is a RE-request only on a PR Kody already reviewed. GitHub sends the
     * same event when an account is asked for the first time (CODEOWNERS, a
     * reviewer picked while opening the PR), and there the `opened` event
     * already decides whether a review runs.
     */
    private async handleReviewRequested(
        params: IWebhookEventParams,
        requestedReviewer: HostAccount,
    ): Promise<void> {
        const { payload, event } = params;
        const prNumber = payload?.pull_request?.number || payload?.number;
        const repository = {
            id: String(payload?.repository?.id),
            name: payload?.repository?.name,
            // GitHub addresses the repository by its own owner, which a
            // token integration's recorded account may not be.
            fullName: payload?.repository?.full_name,
        };
        const metadata = { prNumber, repositoryId: repository.id };

        const context = await this.webhookContextService.getContext(
            PlatformType.GITHUB,
            repository.id,
            githubWebhookSource(payload),
        );
        if (!context?.organizationAndTeamData) {
            return;
        }
        const { organizationAndTeamData } = context;

        try {
            const forKody = await this.codeManagement.isOwnAccount(
                { organizationAndTeamData, account: requestedReviewer },
                PlatformType.GITHUB,
            );
            if (!forKody) {
                return;
            }
            const reviewed =
                await this.codeManagement.getReviewStatusByPullRequest({
                    organizationAndTeamData,
                    repository,
                    prNumber,
                });
            if (!reviewed || reviewed === PullRequestReviewState.NONE) {
                return;
            }
        } catch (error) {
            // A rate limit lifts: the event goes back to the queue, so the
            // click is not lost.
            const classified = classifyGitHubError(error);
            if (isRateLimitError(classified)) throw classified;
            // Anything else would fail the same way again, and nearly every
            // review request is for somebody else.
            this.logger.warn({
                message: `Could not tell whether the review requested on PR#${prNumber} is for Kody`,
                context: GitHubPullRequestHandler.name,
                error,
                metadata,
            });
            return;
        }

        this.logger.log({
            message: `Review re-requested from Kody on PR#${prNumber}`,
            context: GitHubPullRequestHandler.name,
            metadata,
        });

        // Saved as the event it is: a faked `synchronize` would refetch the
        // PR's files and commits, and nothing was pushed.
        await this.savePullRequestUseCase.execute({
            ...params,
            organizationAndTeamData: context?.organizationAndTeamData,
        });
        const jobId = await this.enqueueCodeReviewJobUseCase.execute({
            codeManagementPayload: {
                ...payload,
                action: 'synchronize',
                origin: 'command',
            },
            event,
            platformType: PlatformType.GITHUB,
            organizationAndTeamData,
            teamAutomationId: context.teamAutomationId,
            correlationId: params.correlationId,
        });
        this.logger.log({
            message:
                'Code review job enqueued from a review re-request for asynchronous processing',
            context: GitHubPullRequestHandler.name,
            metadata: { ...metadata, jobId },
        });
    }

    private async handlePullRequest(
        params: IWebhookEventParams,
    ): Promise<void> {
        const { payload, event } = params;

        const prNumber = payload?.pull_request?.number || payload?.number;
        const prUrl = payload?.pull_request?.html_url;

        // TODO: melhorar log
        this.logger.log({
            context: GitHubPullRequestHandler.name,
            serviceName: GitHubPullRequestHandler.name,
            metadata: {
                prNumber,
                prUrl,
            },
            message: `Processing GitHub 'pull_request' event for PR #${prNumber} (${prUrl || 'URL not found'})`,
        });

        const repository = {
            id: String(payload?.repository?.id),
            name: payload?.repository?.name,
            fullName: payload?.repository?.full_name,
        };

        const context = await this.webhookContextService.getContext(
            PlatformType.GITHUB,
            String(payload?.repository?.id),
            githubWebhookSource(payload),
        );

        // If no active automation found, complete the webhook processing immediately
        if (!context?.organizationAndTeamData) {
            this.logger.log({
                message: `No active automation found for repository, completing webhook processing`,
                context: GitHubPullRequestHandler.name,
                metadata: {
                    prNumber,
                    repositoryId: repository.id,
                    repositoryName: repository.name,
                },
            });
            return;
        }

        try {
            await this.savePullRequestUseCase.execute({
                ...params,
                organizationAndTeamData: context?.organizationAndTeamData,
            });

            await this.recordPullRequestEventForRuntime({
                organizationAndTeamData: context.organizationAndTeamData,
                repository,
                prNumber,
                event: payload?.action,
                pullRequest: payload?.pull_request,
                correlationId: params.correlationId,
            });

            if (this.enqueueCodeReviewJobUseCase) {
                this.enqueueCodeReviewJobUseCase
                    .execute({
                        codeManagementPayload: payload,
                        event: event,
                        platformType: PlatformType.GITHUB,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        correlationId: params.correlationId,
                        teamAutomationId: context.teamAutomationId,
                    })
                    .then((jobId) => {
                        this.logger.log({
                            message:
                                'Code review job enqueued for asynchronous processing',
                            context: GitHubPullRequestHandler.name,
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
                            context: GitHubPullRequestHandler.name,
                            error,
                            metadata: {
                                prNumber,
                                repositoryId: repository.id,
                            },
                        });
                    });
            }

            if (payload?.action === 'synchronize') {
                this.enqueueImplementationCheckUseCase
                    .execute({
                        payload: payload,
                        event: event,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                            fullName: repository.fullName,
                        },
                        platformType: PlatformType.GITHUB,
                        pullRequestNumber: payload?.pull_request?.number,
                        commitSha: payload?.after || payload?.head?.sha,
                        trigger: payload?.action,
                    })
                    .catch((e) => {
                        this.logger.error({
                            message: 'Failed to enqueue implementation check',
                            context: GitHubPullRequestHandler.name,
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

                const previousHeadSha = payload?.before;
                const currentHeadSha =
                    payload?.after || payload?.pull_request?.head?.sha;

                if (
                    previousHeadSha &&
                    currentHeadSha &&
                    previousHeadSha !== currentHeadSha
                ) {
                    try {
                        const commits =
                            await this.codeManagement.getCommitsForPullRequestForCodeReview(
                                {
                                    organizationAndTeamData:
                                        context.organizationAndTeamData,
                                    repository: {
                                        id: repository.id,
                                        name: repository.name,
                                        fullName: repository.fullName,
                                    },
                                    prNumber: payload?.pull_request?.number,
                                },
                            );

                        const stillContainsPreviousHead = (commits ?? []).some(
                            (commit) => commit?.sha === previousHeadSha,
                        );

                        if (!stillContainsPreviousHead) {
                            const prKey = `${context.organizationAndTeamData.organizationId}:${repository.id}:${payload?.pull_request?.number}`;
                            await this.outboxRepository.create({
                                jobId: undefined,
                                exchange: 'sandbox.events',
                                routingKey: SANDBOX_INVALIDATE_ROUTING_KEY,
                                payload: {
                                    prKey,
                                    reason: 'force_pushed',
                                } satisfies SandboxInvalidatePayload,
                            });
                        }
                    } catch (err) {
                        this.logger.warn({
                            message:
                                '[SBX-05] Failed to evaluate GitHub force-push heuristic',
                            context: GitHubPullRequestHandler.name,
                            error: err instanceof Error ? err : undefined,
                            metadata: {
                                repositoryId: repository.id,
                                pullRequestNumber:
                                    payload?.pull_request?.number,
                                previousHeadSha,
                                currentHeadSha,
                            },
                        });
                    }
                }
            }

            if (payload?.action === 'closed') {
                this.generateIssuesFromPrClosedUseCase.execute({
                    ...params,
                    organizationAndTeamData: context?.organizationAndTeamData,
                });

                // Durable sandbox invalidation via outbox (SBX-05).
                // Written in the same DB transaction context so it survives worker crashes.
                const prKey = `${context.organizationAndTeamData.organizationId}:${repository.id}:${payload?.pull_request?.number}`;
                await this.outboxRepository
                    .create({
                        jobId: undefined,
                        exchange: 'sandbox.events',
                        routingKey: SANDBOX_INVALIDATE_ROUTING_KEY,
                        payload: {
                            prKey,
                            reason: 'pr_closed',
                        } satisfies SandboxInvalidatePayload,
                    })
                    .catch((err) => {
                        this.logger.warn({
                            message:
                                '[SBX-05] Failed to write sandbox invalidation outbox message',
                            context: GitHubPullRequestHandler.name,
                            error: err instanceof Error ? err : undefined,
                            metadata: { prKey },
                        });
                    });

                // GitHub does not expose a first-class force-push flag on synchronize.
                // A best-effort heuristic now runs in the synchronize path by checking
                // whether payload.before is still present in the PR commit list.

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
                                    fullName: repository.fullName,
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
                                            fullName: repository.fullName,
                                        },
                                        prNumber: payload?.pull_request?.number,
                                    },
                                );

                            this.enqueueAstGraphUpdateOnMergedUseCase
                                ?.execute({
                                    prNumber: payload?.pull_request?.number,
                                    repoExternalId: repository.id,
                                    repoName: repository.name,
                                    platform: PlatformType.GITHUB,
                                    baseBranch: baseRef,
                                    newSha: payload?.pull_request
                                        ?.merge_commit_sha,
                                    organizationAndTeamData:
                                        context.organizationAndTeamData,
                                })
                                .catch((e) => {
                                    this.logger.warn({
                                        message: `[AST-GRAPH] Failed to enqueue graph update after PR#${prNumber} merge`,
                                        context: GitHubPullRequestHandler.name,
                                        error: e,
                                    });
                                });
                        }
                    } catch (e) {
                        this.logger.error({
                            message: 'Failed to sync Kody Rules after PR merge',
                            context: GitHubPullRequestHandler.name,
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
                context: GitHubPullRequestHandler.name,
                serviceName: GitHubPullRequestHandler.name,
                metadata: {
                    prNumber,
                    prUrl,
                    ...context,
                },
                message: `Error processing GitHub pull request #${prNumber}: ${error.message}`,
                error,
            });
            throw error;
        }
    }

    /**
     * Process comment events from GitHub
     */
    private async handleComment(params: IWebhookEventParams): Promise<void> {
        const { payload, event } = params;
        const prNumber = payload?.object_attributes?.iid;

        try {
            // Extract comment data
            const mappedPlatform = getMappedPlatform(PlatformType.GITHUB);

            if (!mappedPlatform) {
                this.logger.error({
                    message: 'Could not get mapped platform for GitHub.',
                    serviceName: GitHubPullRequestHandler.name,
                    metadata: {
                        prNumber,
                    },
                    context: GitHubPullRequestHandler.name,
                });
                return;
            }

            const comment = mappedPlatform.mapComment({ payload });

            if (!comment || !comment.body || payload?.action === 'deleted') {
                this.logger.debug({
                    message:
                        'Comment body empty or action is deleted, skipping.',
                    serviceName: GitHubPullRequestHandler.name,
                    metadata: {
                        prNumber,
                    },
                    context: GitHubPullRequestHandler.name,
                });
                return;
            }

            // `@kody runtime` goes to the Runtime trigger (PR 2), not to a
            // review, on a repository in a Runtime environment: only a new
            // comment asks (an edit does not run it again). Anywhere else it
            // stays what it was before the Runtime, a chat mention.
            const runtimeCtx = isRuntimeCommand(comment.body)
                ? await this.runtimeCommandContext(payload)
                : undefined;
            if (runtimeCtx) {
                if (payload?.action === 'created' && payload?.sender?.type !== 'Bot') {
                    const repositoryId = String(payload?.repository?.id);
                    const number = payload?.issue?.number ?? payload?.pull_request?.number;
                    const isPullRequest = !!payload?.pull_request || !!payload?.issue?.pull_request;
                    if (number && isPullRequest) {
                        await this.recordPullRequestEventForRuntime({
                            organizationAndTeamData: runtimeCtx,
                            repository: { id: repositoryId, name: payload?.repository?.name, fullName: payload?.repository?.full_name },
                            prNumber: number,
                            event: 'comment',
                            pullRequest: payload?.pull_request,
                            commenter: { id: payload?.sender?.id?.toString(), login: payload?.sender?.login },
                            commentId: payload?.comment?.id,
                            correlationId: params.correlationId,
                        });
                    }
                }
                return;
            }

            // `@kody -v <agent>` reviews the PR again with that custom agent only.

            const customAgentSlug = parseCustomAgentCommand(comment.body);

            const isStartCommand =
                isReviewCommand(comment.body) || !!customAgentSlug;
            const isForceCommand = isForceReviewCommand(comment.body);
            const hasMarker = hasReviewMarker(comment.body);

            const pullRequest = mappedPlatform.mapPullRequest({ payload });

            // If it is a start-review command and does not have the review marker
            if (isStartCommand && !hasMarker) {
                this.logger.log({
                    message: `@kody start command detected in GitHub comment for PR#${pullRequest?.number}`,
                    serviceName: GitHubPullRequestHandler.name,
                    metadata: {
                        prNumber,
                    },
                    context: GitHubPullRequestHandler.name,
                });

                // Logic to fetch PR details for GitHub issue_comment
                let pullRequestData = null;
                if (
                    !payload?.pull_request &&
                    payload?.issue &&
                    payload?.issue?.number
                ) {
                    const repository = {
                        id: payload.repository.id,
                        name: payload.repository.name,
                        fullName: payload.repository.full_name,
                    };

                    const userGitId = payload?.sender?.id?.toString();

                    const context = await this.webhookContextService.getContext(
                        PlatformType.GITHUB,
                        String(repository.id),
                        githubWebhookSource(payload),
                    );

                    if (!context?.organizationAndTeamData) {
                        this.logger.warn({
                            message: `No active code review found for PR #${payload.issue.number} via command`,
                            context: GitHubPullRequestHandler.name,
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
                                serviceName: GitHubPullRequestHandler.name,
                                metadata: {
                                    prNumber,
                                    repository,
                                },
                                context: GitHubPullRequestHandler.name,
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
                                    fullName: repository.fullName,
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

                    // Prepare params for the use cases
                    const updatedParams = {
                        ...params,
                        organizationAndTeamData:
                            context?.organizationAndTeamData,
                        payload: {
                            ...payload,
                            action: 'synchronize',
                            origin: isForceCommand
                                ? 'command-force'
                                : 'command',
                            triggerCommentId: comment?.id,
                            reviewDirective: parseReviewDirective(comment.body),
                            requestedReviewMode: requestedReviewModeOf(
                                comment.body,
                            ),
                            requestedReviewModeAccess:
                                await reviewCommandAccess(
                                    this.codeManagement,
                                    params,
                                    context?.organizationAndTeamData,
                                    requestedReviewModeOf(comment.body),
                                ),
                            onlyCustomAgent: customAgentSlug,
                            pull_request:
                                pullRequestData ||
                                pullRequest ||
                                payload?.pull_request,
                        },
                    };

                    // Execute the necessary use cases
                    await this.savePullRequestUseCase.execute(updatedParams);

                    if (
                        this.enqueueCodeReviewJobUseCase &&
                        context?.organizationAndTeamData
                    ) {
                        const jobId =
                            await this.enqueueCodeReviewJobUseCase.execute({
                                codeManagementPayload: updatedParams.payload,
                                event: event,
                                platformType: PlatformType.GITHUB,
                                organizationAndTeamData:
                                    context?.organizationAndTeamData,
                                teamAutomationId: context.teamAutomationId,
                                correlationId: params.correlationId,
                            });

                        this.logger.log({
                            message:
                                'Code review job enqueued from command for asynchronous processing',
                            context: GitHubPullRequestHandler.name,
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
                (isKodyMentionNonReview(comment.body) ||
                    isNewThreadReply(PlatformType.GITHUB, event, payload))
            ) {
                this.chatWithKodyFromGitUseCase.execute(params);
                return;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error processing GitHub pull request comment',
                serviceName: GitHubPullRequestHandler.name,
                metadata: {
                    prNumber,
                },
                context: GitHubPullRequestHandler.name,
                error,
            });
        }
    }

    /**
     * Writes the pull request event for the Runtime trigger (PR 2) to the
     * outbox, only for a repository with a Runtime environment (the gate): any
     * other repository costs no row. It only says what happened; the trigger
     * reads the head, the diff and permissions from the Git API before it
     * decides. A failure here never blocks the review.
     */
    /**
     * The org and team of a repository whose `@kody runtime` belongs to the
     * Runtime: the Runtime is on (the gate is provided) and the repository is
     * in a Runtime environment. A gate that cannot answer counts as in: the
     * command is not handed to the chat, and the record step logs the miss.
     */
    private async runtimeCommandContext(
        payload: any,
    ): Promise<{ organizationId?: string; teamId?: string } | undefined> {
        if (!this.runtimeGate) return undefined;
        const repositoryId = String(payload?.repository?.id);
        const ctx = await this.webhookContextService.getContext(PlatformType.GITHUB, repositoryId);
        const organizationId = ctx?.organizationAndTeamData?.organizationId;
        if (!organizationId) return undefined;
        const inRuntime = await this.runtimeGate
            .shouldRecord({ organizationId, repositoryId })
            .catch(() => true);
        return inRuntime ? ctx.organizationAndTeamData : undefined;
    }

    /**
     * Writes a push to the repository's default branch to the outbox for the
     * Runtime (R6), only for a repository in a Runtime environment (the gate).
     * It only says what happened: the Runtime reads the default branch and its
     * head from the Git API before it sets the environment up again. A failure
     * here never blocks the webhook.
     */
    private async recordDefaultBranchPushForRuntime(
        params: IWebhookEventParams,
    ): Promise<void> {
        const push = defaultBranchPushOf(params.event, params.payload);
        const repository = params.payload?.repository;
        if (!this.runtimeGate || !push || !repository?.id || !repository?.name) {
            return;
        }
        try {
            const context = await this.webhookContextService.getContext(
                PlatformType.GITHUB,
                String(repository.id),
                githubWebhookSource(params.payload),
            );
            const { organizationId, teamId } =
                context?.organizationAndTeamData ?? {};
            if (!organizationId || !teamId) return;
            if (
                !(await this.runtimeGate.shouldRecord({
                    organizationId,
                    repositoryId: String(repository.id),
                }))
            ) {
                return;
            }
            const payload: RuntimeDefaultBranchPushObserved = {
                organizationId,
                teamId,
                repository: {
                    id: String(repository.id),
                    name: repository.name,
                    ...(repository.full_name
                        ? { fullName: repository.full_name }
                        : {}),
                },
                branch: push.branch,
                headSha: push.after,
                observedAt: new Date().toISOString(),
                ...(params.correlationId
                    ? { traceparent: traceparentFor(params.correlationId) }
                    : {}),
            };
            await this.outboxRepository.create(
                runtimePushOutboxMessage(payload, randomUUID()),
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to record the default branch push for Kody Runtime',
                context: GitHubPullRequestHandler.name,
                error,
                metadata: { repositoryId: repository.id },
            });
        }
    }

    private async recordPullRequestEventForRuntime(input: {
        organizationAndTeamData: { organizationId?: string; teamId?: string };
        repository: { id: string; name?: string; fullName?: string };
        prNumber: number;
        event: string;
        pullRequest?: any;
        commenter?: { id?: string; login?: string };
        commentId?: unknown;
        /** The webhook job's correlation id: the Run's trace continues it (traceparentFor). */
        correlationId?: string;
    }): Promise<void> {
        const events: RuntimePullRequestObserved['event'][] = ['opened', 'reopened', 'ready_for_review', 'synchronize', 'closed', 'comment'];
        const event = input.event as RuntimePullRequestObserved['event'];
        const { organizationId, teamId } = input.organizationAndTeamData ?? {};
        if (!this.runtimeGate || !events.includes(event) || !organizationId || !teamId || !input.repository.name || !input.prNumber) return;
        try {
            if (!(await this.runtimeGate.shouldRecord({ organizationId, repositoryId: input.repository.id }))) return;
            const pr = input.pullRequest;
            const headSha = pr?.head?.sha;
            const payload: RuntimePullRequestObserved = {
                organizationId,
                teamId,
                repository: { id: input.repository.id, name: input.repository.name, ...(input.repository.fullName ? { fullName: input.repository.fullName } : {}) },
                prNumber: Number(input.prNumber),
                event,
                ...(typeof headSha === 'string' && /^[0-9a-f]{40}$/.test(headSha) ? { headSha } : {}),
                ...(typeof pr?.draft === 'boolean' ? { draft: pr.draft } : {}),
                labels: (Array.isArray(pr?.labels) ? pr.labels : [])
                    .map((l: { name?: unknown }) => l?.name)
                    .filter((n: unknown): n is string => typeof n === 'string')
                    .slice(0, 100),
                ...(pr?.user ? { author: { login: pr.user.login, isBot: pr.user.type === 'Bot' } } : {}),
                ...(input.commenter ? { commenter: input.commenter } : {}),
                // The comment id lets the trigger read the comment (and its
                // author) back from the Git API; sent once the schema takes it.
                ...(acceptsCommentId && isCommentId(input.commentId) ? { commentId: String(input.commentId) } : {}),
                observedAt: new Date().toISOString(),
                // The webhook has no live span (the product exports none); its correlation id names the trace.
                ...(input.correlationId ? { traceparent: traceparentFor(input.correlationId) } : {}),
            } as RuntimePullRequestObserved;
            await this.outboxRepository.create(runtimeTriggerOutboxMessage(payload, randomUUID()));
        } catch (error) {
            this.logger.error({
                message: 'Failed to record the pull request event for Kody Runtime',
                context: GitHubPullRequestHandler.name,
                error,
                metadata: { prNumber: input.prNumber, repositoryId: input.repository.id, event },
            });
        }
    }
}

const acceptsCommentId = 'commentId' in RuntimePullRequestObservedSchema.shape;
const isCommentId = (value: unknown) =>
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value));
