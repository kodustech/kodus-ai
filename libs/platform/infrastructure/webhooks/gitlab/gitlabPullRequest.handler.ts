import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import {
    hasReviewMarker,
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
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { CodeManagementService } from '../../adapters/services/codeManagement.service';

/**
 * Handler for GitLab webhook events.
 * Processes both merge request and comment events.
 */
@Injectable()
export class GitLabMergeRequestHandler implements IWebhookEventHandler {
    private readonly logger = createLogger(GitLabMergeRequestHandler.name);
    constructor(
        private readonly savePullRequestUseCase: SavePullRequestUseCase,
        private readonly webhookContextService: WebhookContextService,
        private readonly chatWithKodyFromGitUseCase: ChatWithKodyFromGitUseCase,
        private readonly generateIssuesFromPrClosedUseCase: GenerateIssuesFromPrClosedUseCase,
        private readonly eventEmitter: EventEmitter2,
        private readonly codeManagement: CodeManagementService,
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
            params.platformType === PlatformType.GITLAB &&
            ['Merge Request Hook', 'Note Hook'].includes(params.event)
        );
    }

    /**
     * Processes GitLab webhook events.
     * @param params The webhook event parameters.
     */
    public async execute(params: IWebhookEventParams): Promise<void> {
        const { event } = params;

        // Direct to the appropriate method based on the event type
        switch (event) {
            case 'Merge Request Hook':
                await this.handleMergeRequest(params);
                break;
            case 'Note Hook':
                await this.handleComment(params);
                break;
            default:
                this.logger.warn({
                    message: `Unsupported GitLab event: ${event}`,
                    context: GitLabMergeRequestHandler.name,
                });
        }
    }

    private async handleMergeRequest(
        params: IWebhookEventParams,
    ): Promise<void> {
        const { payload, event } = params;
        const mrNumber = payload?.object_attributes?.iid;
        const mrUrl = payload?.object_attributes?.url;

        this.logger.log({
            context: GitLabMergeRequestHandler.name,
            serviceName: GitLabMergeRequestHandler.name,
            message: `Processing GitLab 'Merge Request Hook' event for MR #${mrNumber} (${mrUrl || 'URL not found'})`,
            metadata: { mrNumber, mrUrl },
        });

        const repository = {
            id: String(payload?.project?.id),
            name: payload?.project?.name || payload?.project?.path,
            fullName: payload?.project?.path_with_namespace,
        } as any;

        const mappedPlatform = getMappedPlatform(PlatformType.GITLAB);
        if (!mappedPlatform) {
            this.logger.error({
                message: 'Could not get mapped platform for GitLab.',
                serviceName: GitLabMergeRequestHandler.name,
                metadata: { mrNumber },
                context: GitLabMergeRequestHandler.name,
            });
            return;
        }

        const context = await this.webhookContextService.getContext(
            PlatformType.GITLAB,
            String(payload?.project?.id),
        );

        // If no active automation found, complete the webhook processing immediately
        if (!context?.organizationAndTeamData) {
            this.logger.warn({
                message: `No active automation found for repository, completing webhook processing. Issue generation and all downstream processing will be skipped.`,
                context: GitLabMergeRequestHandler.name,
                metadata: {
                    mrNumber,
                    mrAction: payload?.object_attributes?.action,
                    repositoryId: repository.id,
                    repositoryName: repository.name,
                },
            });
            return;
        }

        try {
            // Check if we should trigger code review based on the MR action
            if (this.shouldTriggerCodeReviewForGitLab(payload)) {
                await this.savePullRequestUseCase.execute(params);

                if (
                    this.enqueueCodeReviewJobUseCase &&
                    context.organizationAndTeamData
                ) {
                    this.enqueueCodeReviewJobUseCase
                        .execute({
                            codeManagementPayload: payload,
                            event: params.event,
                            platformType: PlatformType.GITLAB,
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            correlationId: params.correlationId,
                            teamAutomationId: context.teamAutomationId,
                        })
                        .then((jobId) => {
                            this.logger.log({
                                message:
                                    'Code review job enqueued for asynchronous processing',
                                context: GitLabMergeRequestHandler.name,
                                metadata: {
                                    jobId,
                                    mrNumber,
                                    repositoryId: repository.id,
                                },
                            });
                        })
                        .catch((error) => {
                            this.logger.error({
                                message: 'Failed to enqueue code review job',
                                context: GitLabMergeRequestHandler.name,
                                error,
                                metadata: {
                                    mrNumber,
                                    repositoryId: repository.id,
                                },
                            });
                        });
                } else {
                    this.logger.log({
                        message:
                            'Skipping code review job enqueue (missing org/team or enqueue use case)',
                        context: GitLabMergeRequestHandler.name,
                        metadata: {
                            hasOrgAndTeam: !!context.organizationAndTeamData,
                            mrNumber,
                            repositoryId: repository.id,
                        },
                    });
                }

                if (this.isNewCommitUpdate(payload)) {
                    if (context.organizationAndTeamData) {
                        this.enqueueImplementationCheckUseCase
                            .execute({
                                repository: {
                                    id: repository.id,
                                    name: repository.name,
                                },
                                pullRequestNumber:
                                    payload?.object_attributes?.iid,
                                commitSha:
                                    payload?.object_attributes?.last_commit?.id,
                                trigger: payload?.object_attributes?.action,
                                payload: payload,
                                event: event,
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                                platformType: PlatformType.GITLAB,
                            })
                            .catch((e) => {
                                this.logger.error({
                                    message:
                                        'Failed to enqueue implementation check',
                                    context: GitLabMergeRequestHandler.name,
                                    error: e,
                                    metadata: {
                                        repository,
                                        pullRequestNumber:
                                            payload?.object_attributes?.iid,
                                    },
                                });
                            });
                    }
                }

                if (payload?.object_attributes?.action === 'merge') {
                    try {
                        await this.generateIssuesFromPrClosedUseCase.execute(
                            params,
                        );
                    } catch (error) {
                        this.logger.error({
                            message: 'Failed to generate issues from merged MR',
                            context: GitLabMergeRequestHandler.name,
                            error,
                            metadata: {
                                mrNumber,
                                repositoryId: repository.id,
                            },
                        });
                    }

                    try {
                        if (context.organizationAndTeamData) {
                            const baseRef =
                                payload?.object_attributes?.target_branch;
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
                                        prNumber:
                                            payload?.object_attributes?.iid,
                                    },
                                );
                            this.eventEmitter.emit(
                                'pull-request.closed',
                                new PullRequestClosedEvent(
                                    context.organizationAndTeamData,
                                    repository,
                                    payload?.object_attributes?.iid,
                                    changedFiles || [],
                                ),
                            );
                        }
                    } catch (e) {
                        this.logger.error({
                            message: 'Failed to sync Kody Rules after MR merge',
                            context: GitLabMergeRequestHandler.name,
                            error: e,
                        });
                    }
                }

                return;
            } else if (
                payload?.object_attributes?.action === 'close' ||
                payload?.object_attributes?.action === 'merge' ||
                payload?.object_attributes?.action === 'update'
            ) {
                // For closed or merged MRs, just save the state without triggering automation
                await this.savePullRequestUseCase.execute(params);

                if (payload?.object_attributes?.action === 'merge') {
                    this.generateIssuesFromPrClosedUseCase
                        .execute(params)
                        .catch((error) => {
                            this.logger.error({
                                message:
                                    'Failed to generate issues from merged MR',
                                context: GitLabMergeRequestHandler.name,
                                error,
                                metadata: {
                                    mrNumber,
                                    repositoryId: repository.id,
                                },
                            });
                        });
                }

                return;
            }
        } catch (error) {
            this.logger.error({
                context: GitLabMergeRequestHandler.name,
                serviceName: GitLabMergeRequestHandler.name,
                metadata: {
                    mrNumber,
                    mrUrl,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
                message: `Error processing GitLab merge request #${mrNumber}: ${error.message}`,
                error,
            });
            throw error;
        }
    }

    /**
     * Processes GitLab comment events
     */
    private async handleComment(params: IWebhookEventParams): Promise<void> {
        const { payload } = params;
        const mrNumber = payload?.object_attributes?.iid;
        const repositoryName = payload?.project?.name;

        const mappedPlatform = getMappedPlatform(PlatformType.GITLAB);
        if (!mappedPlatform) {
            this.logger.error({
                message: 'Could not get mapped platform for GitLab.',
                serviceName: GitLabMergeRequestHandler.name,
                metadata: { mrNumber },
                context: GitLabMergeRequestHandler.name,
            });
            return;
        }
        const context = await this.webhookContextService.getContext(
            PlatformType.GITLAB,
            String(payload?.project?.id),
        );

        try {
            // Verify if the action is create
            if (payload?.object_attributes?.action === 'create') {
                const comment = mappedPlatform.mapComment({ payload });
                if (!comment || !comment.body) {
                    this.logger.debug({
                        message: 'Comment body empty, skipping.',
                        serviceName: GitLabMergeRequestHandler.name,
                        metadata: { mrNumber },
                        context: GitLabMergeRequestHandler.name,
                    });
                    return;
                }

                const isStartCommand = isReviewCommand(comment.body);
                const hasMarker = hasReviewMarker(comment.body);

                if (isStartCommand && !hasMarker) {
                    this.logger.log({
                        message: `@kody start command detected in GitLab comment for PR#${mrNumber}`,
                        serviceName: GitLabMergeRequestHandler.name,
                        metadata: { mrNumber },
                        context: GitLabMergeRequestHandler.name,
                    });

                    // Prepare params for use cases
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
                            platformType: PlatformType.GITLAB,
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
            }
        } catch (error) {
            this.logger.error({
                context: GitLabMergeRequestHandler.name,
                serviceName: GitLabMergeRequestHandler.name,
                metadata: { mrNumber },
                message: `Error processing GitLab comment: ${error.message}`,
                error,
            });
            throw error;
        }
    }

    private shouldTriggerCodeReviewForGitLab(params: any): boolean {
        const objectAttributes = params?.object_attributes || {};
        const changes = params?.changes || {};

        // Verify if it's a new MR
        if (objectAttributes.action === 'open') {
            return true;
        }

        // Verify if it's a new commit
        const lastCommitId = objectAttributes.last_commit?.id;
        const oldRev = objectAttributes.oldrev;

        if (lastCommitId && oldRev && lastCommitId !== oldRev) {
            return true;
        }

        // Verify if it's a merge
        if (
            objectAttributes.state === 'merged' ||
            objectAttributes.action === 'merge'
        ) {
            return true;
        }

        // Verify if the PR is closed.
        if (
            objectAttributes.state === 'closed' ||
            objectAttributes.action === 'close'
        ) {
            return true;
        }

        // Ignore if it's an update to the description
        if (objectAttributes.action === 'update' && changes.description) {
            return false;
        }

        if (
            objectAttributes.action === 'update' &&
            changes?.draft &&
            changes.draft.previous === true &&
            changes.draft.current === false
        ) {
            return true;
        }

        // For all other cases, return false
        return false;
    }

    private isNewCommitUpdate(payload: any): boolean {
        const objectAttributes = payload?.object_attributes || {};

        if (objectAttributes.action !== 'update') {
            return false;
        }

        const lastCommitId = objectAttributes.last_commit?.id;
        const oldRev = objectAttributes.oldrev;

        return !!(lastCommitId && oldRev && lastCommitId !== oldRev);
    }
}
