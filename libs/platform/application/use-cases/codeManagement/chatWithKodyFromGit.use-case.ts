import { createLogger, createThreadId } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { BusinessRulesValidationAgentUseCase } from '@libs/agents/application/use-cases/business-rules-validation-agent.use-case';
import { ConversationAgentUseCase } from '@libs/agents/application/use-cases/conversation-agent.use-case';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    ISandboxLeaseManager,
    SANDBOX_LEASE_MANAGER_TOKEN,
    buildPrKey,
} from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { CreateSandboxParams } from '@libs/sandbox/domain/contracts/sandbox.provider';
// Shared with libs/code-review/.../commentAnalysis.service.ts so the
// read-side filter that drops Kody's own past comments stays in sync
// with what every provider emitter actually writes.
import { KODY_IDENTIFIERS } from '@libs/common/utils/kody-identifiers';

import { PlatformResponsePolicyFactory } from './policies/platform-response.policy';

// Constants
const KODY_COMMANDS = {
    BUSINESS_LOGIC_VALIDATION: '@kody -v business-logic',
    KODY_MENTION: '@kody',
    KODUS_MENTION: '@kodus',
} as const;

const ACKNOWLEDGMENT_MESSAGES = {
    DEFAULT: 'Analyzing your request...',
    MARKDOWN_SUFFIX: '<!-- kody-codereview -->\n&#8203;',
    BUSINESS_LOGIC_INVALID_CONTEXT:
        'The "@kody -v business-logic" command can only be used in the general PR conversation, not in code suggestions or inline comments. Please use it in the main PR discussion thread.',
} as const;

enum CommandType {
    BUSINESS_LOGIC_VALIDATION = 'business_logic_validation',
    BUSINESS_LOGIC_INVALID_CONTEXT = 'business_logic_invalid_context',
    CONVERSATION = 'conversation',
    UNKNOWN = 'unknown',
}

interface CommandHandler {
    canHandle(userQuestion: string): boolean;
    getCommandType(): CommandType;
}

class BusinessLogicValidationCommandHandler implements CommandHandler {
    canHandle(userQuestion: string): boolean {
        return userQuestion
            .toLowerCase()
            .trim()
            .startsWith(KODY_COMMANDS.BUSINESS_LOGIC_VALIDATION);
    }

    getCommandType(): CommandType {
        return CommandType.BUSINESS_LOGIC_VALIDATION;
    }
}

class ConversationCommandHandler implements CommandHandler {
    canHandle(userQuestion: string): boolean {
        const trimmedQuestion = userQuestion.toLowerCase().trim();

        const startsWithMention =
            trimmedQuestion.startsWith(KODY_COMMANDS.KODY_MENTION) ||
            trimmedQuestion.startsWith(KODY_COMMANDS.KODUS_MENTION);

        if (!startsWithMention) {
            return false;
        }

        if (trimmedQuestion.includes(' -v ')) {
            return false;
        }

        return true;
    }

    getCommandType(): CommandType {
        return CommandType.CONVERSATION;
    }
}

class CommandManager {
    private handlers: CommandHandler[];

    constructor() {
        this.handlers = [
            new BusinessLogicValidationCommandHandler(),
            new ConversationCommandHandler(),
        ];
    }

    getCommandType(userQuestion: string): CommandType {
        const handler = this.handlers.find((h) => h.canHandle(userQuestion));
        return handler?.getCommandType() ?? CommandType.UNKNOWN;
    }
}

interface WebhookParams {
    event: string;
    payload: any;
    platformType: PlatformType;
}

interface Repository {
    name: string;
    id: string;
    owner?: string;
}

interface Sender {
    login: string;
    id: string;
}

interface Comment {
    id: number;
    body: string;
    in_reply_to_id?: number;
    parent?: {
        id: number;
        links?: any;
    };
    replies?: Comment[];
    content?: {
        raw: string;
        markup?: string;
        html?: string;
        type?: string;
    };
    path?: string;
    deleted?: boolean;
    user?: { login?: string; display_name?: string };
    author?: {
        name?: string;
        username?: string;
        display_name?: string;
        id?: string;
    };
    diff_hunk?: string;
    discussion_id?: string;
    originalCommit?: any;
    subject_type?: string;
    // Azure Repos specific properties
    threadId?: number;
    thread?: any;
    commentType?: string;
}

@Injectable()
export class ChatWithKodyFromGitUseCase {
    private readonly logger = createLogger(ChatWithKodyFromGitUseCase.name);
    private commandManager: CommandManager;

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly conversationAgentUseCase: ConversationAgentUseCase,
        private readonly businessRulesValidationAgentUseCase: BusinessRulesValidationAgentUseCase,

        @Inject(SANDBOX_LEASE_MANAGER_TOKEN)
        private readonly leaseManager: ISandboxLeaseManager,
    ) {}

    async execute(params: WebhookParams): Promise<void> {
        this.logger.log({
            message: 'Receiving pull request review webhook for conversation',
            context: ChatWithKodyFromGitUseCase.name,
            metadata: { eventName: params.event },
        });

        try {
            if (!this.isRelevantAction(params)) {
                return;
            }

            const repository = this.getRepository(params);
            const integrationConfig = await this.getIntegrationConfig(
                params.platformType,
                repository,
            );

            const organizationAndTeamData = integrationConfig
                ? this.extractOrganizationAndTeamData(integrationConfig)
                : null;

            if (
                !integrationConfig ||
                !organizationAndTeamData?.organizationId ||
                !organizationAndTeamData?.teamId
            ) {
                this.logger.warn({
                    message:
                        'No integration config or organization/team data found for repository',
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: {
                        platformType: params.platformType,
                        repository: repository.name,
                        repositoryId: repository.id,
                        hasIntegrationConfig: !!integrationConfig,
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        integrationConfig,
                    },
                });
                return;
            }

            const pullRequestNumber = this.getPullRequestNumber(params);
            const pullRequestDescription =
                this.getPullRequestDescription(params);
            const headRef = this.getHeadRef(params);
            const baseRef = this.getBaseRef(params);
            const defaultBranch = this.getDefaultBranch(params);

            this.logger.log({
                message: 'Extracted PR information',
                context: ChatWithKodyFromGitUseCase.name,
                serviceName: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    platformType: params.platformType,
                    repository: repository.name,
                    pullRequestNumber,
                    hasDescription: !!pullRequestDescription,
                    descriptionLength: pullRequestDescription?.length || 0,
                },
            });

            this.commandManager = new CommandManager();
            const commandType = this.detectCommandType(params);

            if (commandType === CommandType.BUSINESS_LOGIC_VALIDATION) {
                await this.handleBusinessLogicFlow(
                    params,
                    repository,
                    pullRequestNumber,
                    pullRequestDescription,
                    organizationAndTeamData,
                    headRef,
                    baseRef,
                );
            }

            if (commandType === CommandType.BUSINESS_LOGIC_INVALID_CONTEXT) {
                await this.handleBusinessLogicInvalidContextFlow(
                    params,
                    repository,
                    pullRequestNumber,
                    organizationAndTeamData,
                );
            }

            if (commandType === CommandType.CONVERSATION) {
                await this.handleConversationFlow(
                    params,
                    repository,
                    pullRequestNumber,
                    pullRequestDescription,
                    organizationAndTeamData,
                    headRef,
                    baseRef,
                    defaultBranch,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error while executing the git comment response agent',
                context: ChatWithKodyFromGitUseCase.name,
                serviceName: ChatWithKodyFromGitUseCase.name,
                error,
            });
        }
    }

    private isRelevantAction(params: WebhookParams): boolean {
        const action = params.payload?.action;
        const eventType = params.payload?.event_type;
        const allowedActions = new Set(['created', 'edited']);
        const allowedEventTypes = new Set([
            'note',
            'note_edited',
            'comment_created',
            'comment_updated',
        ]);

        if (
            (action && !allowedActions.has(action)) ||
            (!action && eventType && !allowedEventTypes.has(eventType))
        ) {
            return false;
        }

        return true;
    }

    private detectCommandType(params: WebhookParams): CommandType {
        if (params.platformType === PlatformType.GITHUB) {
            const isInlineComment =
                params.event === 'pull_request_review_comment';
            const commentBody =
                params.payload?.comment?.body ||
                params.payload?.issue?.body ||
                '';

            const commandType = this.commandManager.getCommandType(commentBody);

            // Business logic validation only works in general conversation
            if (
                commandType === CommandType.BUSINESS_LOGIC_VALIDATION &&
                isInlineComment
            ) {
                return CommandType.BUSINESS_LOGIC_INVALID_CONTEXT;
            }

            return commandType;
        }

        if (params.platformType === PlatformType.GITLAB) {
            const commentType = params.payload?.object_attributes?.type;
            const isSuggestion = commentType === 'DiffNote';
            const commentBody = params.payload?.object_attributes?.note || '';

            const commandType = this.commandManager.getCommandType(commentBody);

            // Business logic validation only works in general conversation
            if (
                commandType === CommandType.BUSINESS_LOGIC_VALIDATION &&
                isSuggestion
            ) {
                return CommandType.BUSINESS_LOGIC_INVALID_CONTEXT;
            }

            return commandType;
        }

        if (params.platformType === PlatformType.BITBUCKET) {
            const comment = params.payload?.comment;
            const isSuggestion =
                comment?.inline !== null && comment?.inline !== undefined;
            const commentBody = comment?.content?.raw || '';

            const commandType = this.commandManager.getCommandType(commentBody);

            // Business logic validation only works in general conversation
            if (
                commandType === CommandType.BUSINESS_LOGIC_VALIDATION &&
                isSuggestion
            ) {
                return CommandType.BUSINESS_LOGIC_INVALID_CONTEXT;
            }

            return commandType;
        }

        if (params.platformType === PlatformType.AZURE_REPOS) {
            const comment = params.payload?.resource?.comment;
            const isSuggestion = comment?.parentCommentId > 0;
            const commentBody = comment?.content || '';

            const commandType = this.commandManager.getCommandType(commentBody);

            // Business logic validation only works in general conversation
            if (
                commandType === CommandType.BUSINESS_LOGIC_VALIDATION &&
                isSuggestion
            ) {
                return CommandType.BUSINESS_LOGIC_INVALID_CONTEXT;
            }

            return commandType;
        }

        return CommandType.CONVERSATION;
    }

    private async handleBusinessLogicFlow(
        params: WebhookParams,
        repository: Repository,
        pullRequestNumber: number,
        pullRequestDescription: string,
        organizationAndTeamData: OrganizationAndTeamData,
        headRef?: string,
        baseRef?: string,
    ): Promise<void> {
        const sender = this.getSender(params);
        const commentBody =
            params.platformType === PlatformType.GITLAB
                ? params.payload?.object_attributes?.note || ''
                : params.platformType === PlatformType.BITBUCKET
                  ? params.payload?.comment?.content?.raw || ''
                  : params.platformType === PlatformType.AZURE_REPOS
                    ? params.payload?.resource?.comment?.content || ''
                    : params.payload?.comment?.body ||
                      params.payload?.issue?.body ||
                      '';
        const issueId =
            params.platformType === PlatformType.GITLAB
                ? params?.payload?.object_attributes?.noteable_id
                : params.platformType === PlatformType.BITBUCKET
                  ? params?.payload?.pullrequest?.id
                  : params.platformType === PlatformType.AZURE_REPOS
                    ? params?.payload?.resource?.pullRequest?.pullRequestId
                    : params?.payload?.issue?.id;

        const thread = createThreadId(
            {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                repositoryId: repository.id,
                userId: sender.id,
                issueId,
            },
            {
                prefix: 'vbl',
            },
        );

        const responsePolicy = PlatformResponsePolicyFactory.create(
            params.platformType,
        );

        let ackResponse;
        let ackResponseId = null;
        let parentId = null;
        const commentId = this.getCommentId(params);

        if (responsePolicy.usesReaction()) {
            await this.codeManagementService.addReactionToComment({
                organizationAndTeamData,
                repository,
                prNumber: pullRequestNumber,
                commentId,
                reaction: responsePolicy.getAcknowledgmentReaction(),
            });
        } else if (responsePolicy.requiresAcknowledgment()) {
            ackResponse = await this.codeManagementService.createIssueComment({
                organizationAndTeamData,
                repository,
                prNumber: pullRequestNumber,
                body: responsePolicy.getAcknowledgmentBody(),
            });

            if (!ackResponse) {
                this.logger.warn({
                    message: 'Failed to create acknowledgment response',
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: {
                        repository: repository.name,
                        pullRequestNumber,
                    },
                });
                return;
            }

            [ackResponseId, parentId] = this.getBusinessLogicAcknowledgmentIds(
                ackResponse,
                params.platformType,
            );

            if (!ackResponseId) {
                this.logger.warn({
                    message:
                        'Failed to get acknowledgment response ID for business logic',
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: {
                        repository: repository.name,
                        pullRequestNumber,
                        platformType: params.platformType,
                    },
                });
                return;
            }
        }

        const prepareContext = {
            userQuestion: commentBody,
            pullRequest: {
                pullRequestNumber,
                headRef,
                baseRef,
            },
            repository,
            pullRequestDescription,
            platformType: params.platformType,
            customInstructions: this.extractCustomInstructions(params),
        };

        const response = await this.businessRulesValidationAgentUseCase.execute(
            {
                prepareContext,
                organizationAndTeamData,
                thread,
            },
        );

        if (!response) {
            this.logger.warn({
                message:
                    'No response generated by Business Logic Validation Agent',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                },
            });
            return;
        }

        try {
            if (responsePolicy.usesReaction()) {
                await this.codeManagementService.createIssueComment({
                    organizationAndTeamData,
                    repository,
                    prNumber: pullRequestNumber,
                    body: response,
                });

                this.logger.log({
                    message:
                        'Attempting to remove reaction from comment (business logic)',
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: {
                        commentId,
                        reaction: responsePolicy.getAcknowledgmentReaction(),
                    },
                });

                try {
                    await this.codeManagementService.removeReactionsFromComment(
                        {
                            organizationAndTeamData,
                            repository,
                            prNumber: pullRequestNumber,
                            commentId,
                            reactions: [
                                responsePolicy.getAcknowledgmentReaction(),
                            ],
                        },
                    );

                    this.logger.log({
                        message:
                            'Successfully removed reaction from comment (business logic)',
                        context: ChatWithKodyFromGitUseCase.name,
                        metadata: { commentId },
                    });
                } catch (removeError) {
                    this.logger.error({
                        message:
                            'Failed to remove reaction from comment (business logic)',
                        context: ChatWithKodyFromGitUseCase.name,
                        error: removeError,
                        metadata: {
                            commentId,
                            reaction:
                                responsePolicy.getAcknowledgmentReaction(),
                        },
                    });
                }
            } else if (responsePolicy.requiresAcknowledgment()) {
                const updateParams: {
                    organizationAndTeamData: OrganizationAndTeamData;
                    repository: { name: string; id: string };
                    prNumber: number;
                    commentId: number;
                    body: string;
                    noteId?: number;
                    threadId?: number;
                } = {
                    organizationAndTeamData,
                    repository,
                    prNumber: pullRequestNumber,
                    commentId: Number(ackResponseId),
                    body: response,
                };

                if (params.platformType === PlatformType.GITLAB) {
                    updateParams.noteId = parentId
                        ? Number(parentId)
                        : undefined;
                } else if (params.platformType === PlatformType.AZURE_REPOS) {
                    updateParams.threadId = parentId
                        ? Number(parentId)
                        : undefined;
                }

                await this.codeManagementService.updateIssueComment(
                    updateParams,
                );
            }

            this.logger.log({
                message:
                    'Successfully created/updated PR response for business logic validation',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to create/update PR response for business logic validation',
                context: ChatWithKodyFromGitUseCase.name,
                error,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                },
            });
            return;
        }

        this.logger.log({
            message: 'Successfully executed business logic validation',
            context: ChatWithKodyFromGitUseCase.name,
            metadata: {
                repository: repository.name,
                pullRequestNumber,
            },
        });
    }

    private async handleConversationFlow(
        params: WebhookParams,
        repository: Repository,
        pullRequestNumber: number,
        pullRequestDescription: string,
        organizationAndTeamData: OrganizationAndTeamData,
        headRef?: string,
        baseRef?: string,
        defaultBranch?: string,
    ): Promise<void> {
        const allComments =
            await this.codeManagementService.getPullRequestReviewComment({
                organizationAndTeamData,
                filters: {
                    pullRequestNumber,
                    repository,
                    discussionId:
                        params.payload?.object_attributes?.discussion_id,
                },
            });

        // GitLab-only: when discussion_id is missing from the webhook,
        // getPullRequestReviewComment returns raw discussions (with notes[]).
        // Flatten to note-shaped objects so find-by-note-id works.
        const isGitLabWithMissingDiscussionId =
            params.payload?.object_attributes !== undefined &&
            !params.payload?.object_attributes?.discussion_id;

        const normalizedComments = isGitLabWithMissingDiscussionId
            ? allComments?.flatMap((d) => {
                  const firstNote = d.notes?.[0];
                  return (d.notes || []).map((note) => ({
                      ...note,
                      id: note.id,
                      discussionId: d.id,
                      originalCommit: firstNote
                          ? {
                                body: firstNote.body,
                                id: firstNote.id,
                            }
                          : undefined,
                  }));
              })
            : allComments;

        const commentId = this.getCommentId(params);
        const comment =
            params.platformType !== PlatformType.AZURE_REPOS
                ? normalizedComments?.find((c) => c.id === commentId)
                : this.getReviewThreadByCommentId(
                      commentId,
                      normalizedComments,
                      params,
                  );

        if (!comment) {
            return;
        }

        if (this.shouldIgnoreComment(comment, params.platformType)) {
            this.logger.log({
                message:
                    'Comment made by Kody or does not mention Kody/Kodus. Ignoring.',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                },
            });
            return;
        }

        const originalKodyComment = this.getOriginalKodyComment(
            comment,
            normalizedComments,
            params.platformType,
        );
        const othersReplies = this.getOthersReplies(
            comment,
            normalizedComments,
            params.platformType,
        );
        const sender = this.getSender(params);

        const responsePolicy = PlatformResponsePolicyFactory.create(
            params.platformType,
        );

        let ackResponse;
        let ackResponseId = null;
        let parentId = null;

        if (responsePolicy.usesReaction()) {
            await this.codeManagementService.addReactionToComment({
                organizationAndTeamData,
                repository,
                prNumber: pullRequestNumber,
                commentId: comment.id,
                reaction: responsePolicy.getAcknowledgmentReaction(),
            });
        } else if (responsePolicy.requiresAcknowledgment()) {
            ackResponse =
                await this.codeManagementService.createResponseToComment({
                    organizationAndTeamData,
                    inReplyToId: comment.id,
                    discussionId:
                        params.payload?.object_attributes?.discussion_id ??
                        comment.discussionId,
                    threadId: comment.threadId,
                    body: responsePolicy.getAcknowledgmentBody(),
                    repository,
                    prNumber: pullRequestNumber,
                });

            if (!ackResponse) {
                this.logger.warn({
                    message: 'Failed to create acknowledgment response',
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: {
                        repository: repository.name,
                        pullRequestNumber,
                        commentId: comment.id,
                    },
                });
                return;
            }

            [ackResponseId, parentId] = this.getAcknowledgmentIds(
                originalKodyComment,
                ackResponse,
                params.platformType,
                comment,
            );

            if (!ackResponseId || !parentId) {
                this.logger.warn({
                    message:
                        'Failed to get acknowledgment response ID or parent ID',
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: {
                        repository: repository.name,
                        pullRequestNumber,
                        commentId: comment.id,
                    },
                });
                return;
            }
        }

        const gitUser = this.getGitUser(params);

        const prepareContext = this.prepareContext({
            comment,
            originalKodyComment,
            gitUser,
            othersReplies,
            pullRequestNumber,
            repository,
            pullRequestDescription,
            platformType: params.platformType,
            headRef,
            baseRef,
            defaultBranch,
            customInstructions: this.extractCustomInstructions(params),
        });

        const thread = createThreadId(
            {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                repositoryId: repository.id,
                userId: sender.id,
                suggestionCommentId: originalKodyComment?.id || comment?.id,
            },
            {
                prefix: 'cmc',
            },
        );

        const commandType = this.commandManager.getCommandType(
            prepareContext.userQuestion,
        );

        const response = await this.processCommand(commandType, {
            prepareContext,
            organizationAndTeamData,
            thread,
        });

        if (!response) {
            this.logger.warn({
                message: 'No response generated by Kody',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                    commentId: comment.id,
                },
            });
            return;
        }

        try {
            if (responsePolicy.usesReaction()) {
                await this.codeManagementService.createResponseToComment({
                    organizationAndTeamData,
                    inReplyToId: comment.id,
                    discussionId:
                        params.payload?.object_attributes?.discussion_id ??
                        comment.discussionId,
                    threadId: comment.threadId,
                    body: response,
                    repository,
                    prNumber: pullRequestNumber,
                });

                this.logger.log({
                    message: 'Attempting to remove reaction from comment',
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: {
                        commentId: comment.id,
                        reaction: responsePolicy.getAcknowledgmentReaction(),
                        organizationAndTeamData,
                    },
                });

                try {
                    await this.codeManagementService.removeReactionsFromComment(
                        {
                            organizationAndTeamData,
                            repository,
                            prNumber: pullRequestNumber,
                            commentId: comment.id,
                            reactions: [
                                responsePolicy.getAcknowledgmentReaction(),
                            ],
                        },
                    );

                    this.logger.log({
                        message: 'Successfully removed reaction from comment',
                        context: ChatWithKodyFromGitUseCase.name,
                        metadata: {
                            commentId: comment.id,
                            organizationAndTeamData,
                        },
                    });
                } catch (removeError) {
                    this.logger.error({
                        message: 'Failed to remove reaction from comment',
                        context: ChatWithKodyFromGitUseCase.name,
                        error: removeError,
                        metadata: {
                            commentId: comment.id,
                            organizationAndTeamData,
                            reaction:
                                responsePolicy.getAcknowledgmentReaction(),
                        },
                    });
                }
            } else if (responsePolicy.requiresAcknowledgment()) {
                await this.codeManagementService.updateResponseToComment({
                    organizationAndTeamData,
                    parentId,
                    commentId: ackResponseId,
                    body: response,
                    prNumber: pullRequestNumber,
                    repository,
                });
            }

            this.logger.log({
                message: 'Successfully executed conversation flow',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                    commentId: comment.id,
                    responseId: ackResponseId,
                    organizationAndTeamData,
                },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to create/update response in conversation flow',
                context: ChatWithKodyFromGitUseCase.name,
                error,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                    commentId: comment.id,
                    organizationAndTeamData,
                },
            });
        }
    }

    private async handleBusinessLogicInvalidContextFlow(
        params: WebhookParams,
        repository: Repository,
        pullRequestNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const allComments =
            await this.codeManagementService.getPullRequestReviewComment({
                organizationAndTeamData,
                filters: {
                    pullRequestNumber,
                    repository,
                    discussionId:
                        params.payload?.object_attributes?.discussion_id,
                },
            });

        // GitLab-only: when discussion_id is missing from the webhook,
        // getPullRequestReviewComment returns raw discussions (with notes[]).
        // Flatten to note-shaped objects so find-by-note-id works.
        const isGitLabWithMissingDiscussionId =
            params.payload?.object_attributes !== undefined &&
            !params.payload?.object_attributes?.discussion_id;

        const normalizedComments = isGitLabWithMissingDiscussionId
            ? allComments?.flatMap((d) => {
                  const firstNote = d.notes?.[0];
                  return (d.notes || []).map((note) => ({
                      ...note,
                      id: note.id,
                      discussionId: d.id,
                      originalCommit: firstNote
                          ? {
                                body: firstNote.body,
                                id: firstNote.id,
                            }
                          : undefined,
                  }));
              })
            : allComments;

        const commentId = this.getCommentId(params);
        const comment =
            params.platformType !== PlatformType.AZURE_REPOS
                ? normalizedComments?.find((c) => c.id === commentId)
                : this.getReviewThreadByCommentId(
                      commentId,
                      normalizedComments,
                      params,
                  );

        if (!comment) {
            this.logger.warn({
                message: 'Comment not found for invalid business logic context',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                    commentId,
                    organizationAndTeamData,
                },
            });
            return;
        }

        const response =
            await this.codeManagementService.createResponseToComment({
                organizationAndTeamData,
                inReplyToId: comment.id,
                discussionId:
                    params.payload?.object_attributes?.discussion_id ??
                    comment.discussionId,
                threadId: comment.threadId ?? comment?.in_reply_to_id,
                body: ACKNOWLEDGMENT_MESSAGES.BUSINESS_LOGIC_INVALID_CONTEXT,
                repository,
                prNumber: pullRequestNumber,
            });

        if (!response) {
            this.logger.warn({
                message:
                    'Failed to create response for invalid business logic context',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                    commentId: comment.id,
                    organizationAndTeamData,
                },
            });
            return;
        }

        this.logger.log({
            message:
                'Successfully showed invalid context message for business logic command',
            context: ChatWithKodyFromGitUseCase.name,
            metadata: {
                organizationAndTeamData,
                repository: repository.name,
                pullRequestNumber,
                commentId: comment.id,
                responseId: response.id,
            },
        });
    }

    private async getIntegrationConfig(
        platformType: PlatformType,
        repository: Repository,
    ): Promise<IntegrationConfigEntity> {
        return await this.codeManagementService.findTeamAndOrganizationIdByConfigKey(
            {
                repository: repository,
            },
            platformType,
        );
    }

    private extractOrganizationAndTeamData(
        integrationConfig: IntegrationConfigEntity,
    ): OrganizationAndTeamData {
        return {
            organizationId: integrationConfig?.integration?.organization?.uuid,
            teamId: integrationConfig?.team?.uuid,
        };
    }

    private getRepository(params: WebhookParams): Repository {
        switch (params.platformType) {
            case PlatformType.GITHUB: {
                const fallbackRepository =
                    this.extractRepositoryFromGitHubPullRequestUrl(params);

                return {
                    name:
                        params.payload?.repository?.name ||
                        fallbackRepository.name ||
                        '',
                    id: params.payload?.repository?.id,
                    owner:
                        params.payload?.repository?.owner?.login ||
                        fallbackRepository.owner ||
                        '',
                };
            }
            case PlatformType.GITLAB:
                return {
                    name: params.payload?.project?.name,
                    id: params.payload?.project?.id,
                    owner:
                        params.payload?.project?.namespace ||
                        params.payload?.project?.path_with_namespace
                            ?.split('/')
                            ?.slice(0, -1)
                            ?.join('/') ||
                        '',
                };
            case PlatformType.BITBUCKET:
                return {
                    name: params.payload?.repository?.name,
                    id:
                        params.payload?.repository?.uuid?.slice(1, -1) ||
                        params.payload?.repository?.id,
                    owner:
                        params.payload?.repository?.workspace?.slug ||
                        params.payload?.repository?.owner?.username ||
                        params.payload?.repository?.full_name
                            ?.split('/')
                            ?.at(0) ||
                        '',
                };
            case PlatformType.AZURE_REPOS:
                return {
                    name: params.payload?.resource?.pullRequest?.repository
                        ?.name,
                    id: params.payload?.resource?.pullRequest?.repository?.id,
                    owner:
                        params.payload?.resource?.repository?.project?.name ||
                        params.payload?.resourceContainers?.project?.id ||
                        '',
                };
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${params.platformType}`,
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: { platformType: params.platformType },
                });
                return { name: '', id: '' };
        }
    }

    private getRepositoryOwner(
        params: WebhookParams,
        repository?: Repository,
    ): string {
        if (repository?.owner?.trim()) {
            return repository.owner.trim();
        }

        switch (params.platformType) {
            case PlatformType.GITHUB: {
                const fallbackRepository =
                    this.extractRepositoryFromGitHubPullRequestUrl(params);
                return (
                    params.payload?.repository?.owner?.login ||
                    fallbackRepository.owner ||
                    ''
                );
            }
            case PlatformType.GITLAB:
                return (
                    params.payload?.project?.namespace ||
                    params.payload?.project?.path_with_namespace
                        ?.split('/')
                        ?.slice(0, -1)
                        ?.join('/') ||
                    ''
                );
            case PlatformType.BITBUCKET:
                return (
                    params.payload?.repository?.workspace?.slug ||
                    params.payload?.repository?.owner?.username ||
                    params.payload?.repository?.full_name?.split('/')?.at(0) ||
                    ''
                );
            case PlatformType.AZURE_REPOS:
                return (
                    params.payload?.resource?.repository?.project?.name ||
                    params.payload?.resourceContainers?.project?.id ||
                    ''
                );
            default:
                return '';
        }
    }

    private extractRepositoryFromGitHubPullRequestUrl(params: WebhookParams): {
        owner: string;
        name: string;
    } {
        const pullRequestUrl = params.payload?.issue?.pull_request?.url;

        if (typeof pullRequestUrl !== 'string' || !pullRequestUrl.length) {
            return { owner: '', name: '' };
        }

        const match = pullRequestUrl.match(
            /\/repos\/([^/]+)\/([^/]+)\/pulls\/\d+/,
        );

        if (!match) {
            return { owner: '', name: '' };
        }

        return {
            owner: match[1],
            name: match[2],
        };
    }

    private getPullRequestNumber(params: WebhookParams): number {
        switch (params.platformType) {
            case PlatformType.GITHUB:
                if (
                    params.event === 'issue_comment' &&
                    params.payload?.issue?.pull_request?.url
                ) {
                    const url = params.payload.issue.pull_request.url;
                    const match = url.match(/\/pulls\/(\d+)/);
                    if (match) {
                        return parseInt(match[1], 10);
                    } else {
                        return 0;
                    }
                }

                return params.payload?.pull_request?.number || 0;
            case PlatformType.GITLAB:
                return params.payload?.merge_request?.iid;
            case PlatformType.BITBUCKET:
                return params.payload?.pullrequest?.id;
            case PlatformType.AZURE_REPOS:
                return params.payload?.resource?.pullRequest?.pullRequestId;
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${params.platformType}`,
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: { platformType: params.platformType },
                });
                return 0;
        }
    }

    private getHeadRef(params: WebhookParams): string {
        switch (params.platformType) {
            case PlatformType.GITHUB:
                return params.payload?.pull_request?.head?.ref || '';
            case PlatformType.GITLAB:
                return params.payload?.merge_request?.source_branch || '';
            case PlatformType.BITBUCKET:
                return params.payload?.pullrequest?.source?.branch?.name || '';
            case PlatformType.AZURE_REPOS:
                return (
                    params.payload?.resource?.pullRequest?.sourceRefName?.replace(
                        'refs/heads/',
                        '',
                    ) || ''
                );
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${params.platformType} for head ref`,
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: { platformType: params.platformType },
                });
                return '';
        }
    }

    private getBaseRef(params: WebhookParams): string {
        switch (params.platformType) {
            case PlatformType.GITHUB:
                return params.payload?.pull_request?.base?.ref || '';
            case PlatformType.GITLAB:
                return params.payload?.merge_request?.target_branch || '';
            case PlatformType.BITBUCKET:
                return (
                    params.payload?.pullrequest?.destination?.branch?.name || ''
                );
            case PlatformType.AZURE_REPOS:
                return (
                    params.payload?.resource?.pullRequest?.targetRefName?.replace(
                        'refs/heads/',
                        '',
                    ) || ''
                );
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${params.platformType} for base ref`,
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: { platformType: params.platformType },
                });
                return '';
        }
    }

    private getDefaultBranch(params: WebhookParams): string {
        switch (params.platformType) {
            case PlatformType.GITHUB:
                return (
                    params.payload?.repository?.default_branch ||
                    params.payload?.pull_request?.base?.repo?.default_branch ||
                    ''
                );
            case PlatformType.GITLAB:
                return (
                    params.payload?.project?.default_branch ||
                    params.payload?.repository?.default_branch ||
                    ''
                );
            case PlatformType.BITBUCKET:
                return (
                    params.payload?.repository?.mainbranch?.name ||
                    params.payload?.pullrequest?.destination?.branch?.name ||
                    ''
                );
            case PlatformType.AZURE_REPOS:
                return (
                    params.payload?.resource?.repository?.defaultBranch?.replace(
                        'refs/heads/',
                        '',
                    ) || ''
                );
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${params.platformType} for default branch`,
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: { platformType: params.platformType },
                });
                return '';
        }
    }

    private getPullRequestDescription(params: WebhookParams): string {
        let description: string;

        switch (params.platformType) {
            case PlatformType.GITHUB:
                // Se for issue_comment, pegar description do issue
                if (params.event === 'issue_comment') {
                    description = params.payload?.issue?.body || '';
                } else {
                    // Caso normal (PR webhook)
                    description =
                        params.payload?.pull_request?.body ||
                        params.payload?.pull_request?.description ||
                        '';
                }
                break;
            case PlatformType.GITLAB:
                description =
                    params.payload?.merge_request?.description ||
                    params.payload?.merge_request?.body ||
                    '';
                break;
            case PlatformType.BITBUCKET:
                description =
                    params.payload?.pullrequest?.description ||
                    params.payload?.pullrequest?.summary ||
                    '';
                break;
            case PlatformType.AZURE_REPOS:
                description =
                    params.payload?.resource?.pullRequest?.description || '';
                break;
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${params.platformType} for PR description`,
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: { platformType: params.platformType },
                });
                return '';
        }

        this.logger.log({
            message: 'PR description extracted',
            context: ChatWithKodyFromGitUseCase.name,
            serviceName: ChatWithKodyFromGitUseCase.name,
            metadata: {
                platformType: params.platformType,
                hasDescription: !!description,
                descriptionLength: description.length,
                descriptionPreview: description.substring(0, 100),
            },
        });

        return description;
    }

    private getReviewThreadByCommentId(
        commentId: number,
        reviewComments: any[],
        params?: WebhookParams,
    ): any | null {
        try {
            if (params?.platformType === PlatformType.AZURE_REPOS) {
                const threadId = this.getThreadIdFromAzurePayload(params);
                if (threadId) {
                    const thread = reviewComments?.find(
                        (t) => t.threadId === threadId,
                    );
                    if (thread) {
                        const targetComment = thread.replies?.find(
                            (c: any) => c.id === commentId,
                        );
                        if (targetComment) {
                            return {
                                ...targetComment,
                                thread,
                            };
                        }
                    }
                }
            }

            return null;
        } catch (error) {
            this.logger.error({
                message: 'Failed to find thread by commentId',
                context:
                    'ChatWithKodyFromGitUseCase.getReviewThreadByCommentId',
                error,
                metadata: { commentId, platformType: params?.platformType },
            });
            return null;
        }
    }

    private getCommentId(params: WebhookParams): number {
        switch (params.platformType) {
            case PlatformType.GITHUB:
                return params.payload?.comment?.id;
            case PlatformType.GITLAB:
                return params.payload?.object_attributes?.id;
            case PlatformType.BITBUCKET:
                return params.payload?.comment?.id;
            case PlatformType.AZURE_REPOS:
                return params.payload?.resource?.comment?.id;
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${params.platformType}`,
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: { platformType: params.platformType },
                });
                return 0;
        }
    }

    private getThreadIdFromAzurePayload(params: WebhookParams): number | null {
        if (params.platformType !== PlatformType.AZURE_REPOS) {
            return null;
        }

        try {
            // Extrair threadId da URL nos _links do comentário
            const threadLink =
                params.payload?.resource?.comment?._links?.threads?.href;
            if (threadLink) {
                const threadIdMatch = threadLink.match(/\/threads\/(\d+)/);
                if (threadIdMatch) {
                    return parseInt(threadIdMatch[1], 10);
                }
            }

            // Fallback: extrair da URL do HTML (discussionId)
            const htmlContent =
                params.payload?.message?.html ||
                params.payload?.detailedMessage?.html;
            if (htmlContent) {
                const discussionIdMatch =
                    htmlContent.match(/discussionId=(\d+)/);
                if (discussionIdMatch) {
                    return parseInt(discussionIdMatch[1], 10);
                }
            }

            return null;
        } catch (error) {
            this.logger.error({
                message: 'Failed to extract threadId from Azure payload',
                context: ChatWithKodyFromGitUseCase.name,
                error,
                metadata: { platformType: params.platformType },
            });
            return null;
        }
    }

    private shouldIgnoreComment(
        comment: any,
        platformType: PlatformType,
    ): boolean {
        return (
            this.isKodyComment(comment, platformType) ||
            !this.mentionsKody(comment)
        );
    }

    private getOriginalKodyComment(
        comment: Comment,
        allComments: Comment[],
        platformType: PlatformType,
    ): Comment | undefined {
        switch (platformType) {
            case PlatformType.GITHUB:
                if (
                    !comment?.id &&
                    !comment?.in_reply_to_id &&
                    !comment?.subject_type
                ) {
                    return undefined;
                }

                return allComments.find(
                    (originalComment) =>
                        originalComment.id ===
                        (comment?.in_reply_to_id ?? comment?.id),
                );
            case PlatformType.GITLAB:
                return comment?.originalCommit;
            case PlatformType.BITBUCKET: {
                if (!comment?.parent?.id) {
                    return undefined;
                }

                const originalComment = allComments.find(
                    (c) => c.id === comment.parent.id,
                );

                return originalComment;
            }
            case PlatformType.AZURE_REPOS:
                if (comment.threadId && comment.id !== comment.threadId) {
                    const originalComment = comment.thread;
                    return originalComment;
                }
                return undefined;
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${platformType}`,
                    context: ChatWithKodyFromGitUseCase.name,
                });
                return undefined;
        }
    }

    private getOthersReplies(
        comment: Comment,
        allComments: Comment[],
        platformType: PlatformType,
    ): Comment[] {
        switch (platformType) {
            case PlatformType.GITHUB:
                return allComments.filter(
                    (reply) =>
                        reply.in_reply_to_id === comment.in_reply_to_id &&
                        !this.isKodyComment(reply, platformType),
                );
            case PlatformType.BITBUCKET:
                if (comment.parent?.id) {
                    const originalComment = allComments.find(
                        (c) => c.id === comment.parent.id,
                    );

                    if (!originalComment) {
                        return [];
                    }

                    if (
                        originalComment.replies &&
                        Array.isArray(originalComment.replies)
                    ) {
                        const validReplies = [];

                        for (const reply of originalComment.replies) {
                            if (
                                reply.content?.raw === '' ||
                                reply.deleted === true
                            ) {
                                continue;
                            }

                            if (reply.id === comment.id) {
                                continue;
                            }
                            if (
                                this.isKodyComment(
                                    {
                                        body: reply.content?.raw,
                                        id: reply.id,
                                        author: {
                                            name: reply.user?.display_name,
                                        },
                                    },
                                    platformType,
                                )
                            ) {
                                continue;
                            }

                            if (reply.content?.raw) {
                                validReplies.push({
                                    ...reply,
                                    body: reply.content.raw,
                                });
                            } else {
                                validReplies.push(reply);
                            }
                        }

                        return validReplies;
                    }
                }
                return [];
            case PlatformType.AZURE_REPOS:
                if (comment.threadId) {
                    const thread = allComments.find(
                        (c) => c.threadId === comment.threadId,
                    );

                    if (
                        thread &&
                        thread.replies &&
                        Array.isArray(thread.replies)
                    ) {
                        return thread.replies.filter(
                            (reply) =>
                                reply.id !== comment.id &&
                                !this.isKodyComment(reply, platformType),
                        );
                    }
                    return [];
                }

                return allComments.filter(
                    (reply) =>
                        reply.in_reply_to_id === comment.in_reply_to_id &&
                        !this.isKodyComment(reply, platformType),
                );
            case PlatformType.GITLAB:
                return allComments.filter(
                    (reply) =>
                        ((reply.in_reply_to_id !== undefined &&
                            reply.in_reply_to_id ===
                                comment.in_reply_to_id) ||
                            reply.discussionId === comment.discussionId) &&
                        !this.isKodyComment(reply, platformType),
                );
            default:
                this.logger.warn({
                    message: `Plataforma nu00e3o suportada: ${platformType}`,
                    context: ChatWithKodyFromGitUseCase.name,
                });
                return [];
        }
    }

    private getSender(params: WebhookParams): Sender {
        switch (params.platformType) {
            case PlatformType.GITHUB:
                return {
                    login: params.payload?.sender?.login,
                    id: params.payload?.sender?.id,
                };
            case PlatformType.GITLAB:
                return {
                    login: params.payload?.user?.name,
                    id: params.payload?.user?.id,
                };
            case PlatformType.BITBUCKET:
                return {
                    login:
                        params.payload?.actor?.display_name ||
                        params.payload?.actor?.nickname,
                    id:
                        params.payload?.actor?.uuid?.slice(1, -1) ||
                        params.payload?.actor?.account_id,
                };
            case PlatformType.AZURE_REPOS:
                return {
                    login: params.payload?.resource?.comment?.author
                        ?.displayName,
                    id: params.payload?.resource?.comment?.author?.id,
                };
            default:
                this.logger.warn({
                    message: `Plataforma nu00e3o suportada: ${params.platformType}`,
                    context: ChatWithKodyFromGitUseCase.name,
                });
                return { login: '', id: '' };
        }
    }

    private prepareContext({
        comment,
        originalKodyComment,
        gitUser,
        othersReplies,
        pullRequestNumber,
        repository,
        pullRequestDescription,
        platformType,
        headRef,
        baseRef,
        defaultBranch,
        customInstructions,
    }: {
        comment?: Comment;
        originalKodyComment?: Comment;
        gitUser?: { id: number; username: string };
        othersReplies?: Comment[];
        repository?: Repository;
        platformType?: PlatformType;
        pullRequestNumber?: number;
        pullRequestDescription?: string;
        headRef?: string;
        baseRef?: string;
        defaultBranch?: string;
        customInstructions?: string;
    }): any {
        const userQuestion =
            comment.body.trim() === '@kody'
                ? 'The user did not ask any questions. Ask them what they would like to know about the codebase or suggestions for code changes.'
                : comment.body;

        return {
            gitUser,
            userQuestion,
            repository: {
                ...repository,
                defaultBranch: defaultBranch ?? baseRef,
            },
            pullRequestDescription,
            platformType,
            customInstructions,
            pullRequest: {
                pullRequestNumber,
                headRef: headRef,
                baseRef: baseRef,
            },
            codeManagementContext: {
                originalComment: {
                    suggestionCommentId: originalKodyComment?.id,
                    suggestionFilePath: comment?.path,
                    suggestionText: originalKodyComment?.body,
                    diffHunk: originalKodyComment?.diff_hunk,
                },
                othersReplies: othersReplies.map((reply) => ({
                    historyConversationText: reply.body,
                })),
            },
        };
    }

    private mentionsKody(comment: Comment): boolean {
        const commentBody = comment.body.toLowerCase();
        return [KODY_COMMANDS.KODY_MENTION, KODY_COMMANDS.KODUS_MENTION].some(
            (keyword) => commentBody.startsWith(keyword),
        );
    }

    private isKodyComment(
        comment: Comment,
        platformType: PlatformType,
    ): boolean {
        const login =
            platformType === PlatformType.GITHUB
                ? comment.user?.login
                : comment.author?.name;
        const body = comment.body.toLowerCase();
        const bodyWithoutMarkdown =
            platformType !== PlatformType.BITBUCKET
                ? KODY_IDENTIFIERS.MARKDOWN_IDENTIFIERS.DEFAULT
                : KODY_IDENTIFIERS.MARKDOWN_IDENTIFIERS.BITBUCKET;

        return (
            KODY_IDENTIFIERS.LOGIN_KEYWORDS.some((keyword) =>
                login?.includes(keyword),
            ) || body.includes(bodyWithoutMarkdown)
        );
    }

    private getAcknowledgmentIds(
        originalKodyComment: Comment,
        ackResponse: any,
        platformType: PlatformType,
        comment?: Comment,
    ): [ackResponseId: string, parentId: string] {
        let ackResponseId;
        let parentId;

        switch (platformType) {
            case PlatformType.GITHUB:
                ackResponseId = ackResponse.id;
                parentId = originalKodyComment?.id;
                break;
            case PlatformType.GITLAB:
                ackResponseId = ackResponse.id;
                parentId = comment?.id;
                break;
            case PlatformType.BITBUCKET:
                ackResponseId = ackResponse.id;
                parentId =
                    ackResponse.parent?.id === comment?.id
                        ? ackResponse.parent?.id
                        : originalKodyComment?.id;
                break;
            case PlatformType.AZURE_REPOS:
                ackResponseId = ackResponse?.id;
                parentId = originalKodyComment?.threadId;
                break;
            default:
                this.logger.warn({
                    message: `Unsupported platform type: ${platformType}`,
                    context: ChatWithKodyFromGitUseCase.name,
                    metadata: {
                        originalKodyComment,
                        ackResponse,
                        platformType,
                    },
                });
                return ['', ''];
        }

        if (!ackResponseId || !parentId) {
            return ['', ''];
        }

        return [ackResponseId, parentId];
    }

    private getBusinessLogicAcknowledgmentIds(
        ackResponse: any,
        platformType: PlatformType,
    ): [string | number | null, string | number | null] {
        let ackResponseId;
        let parentId;

        switch (platformType) {
            case PlatformType.GITHUB:
                ackResponseId = ackResponse?.id;
                parentId = ackResponse?.id;
                break;

            case PlatformType.GITLAB:
                ackResponseId = ackResponse?.id;
                parentId = ackResponse?.notes?.[0]?.id;
                break;

            case PlatformType.BITBUCKET:
                ackResponseId = ackResponse?.id;
                parentId = ackResponse?.id;
                break;

            case PlatformType.AZURE_REPOS:
                ackResponseId = ackResponse?.id;
                parentId = ackResponse?.threadId;
                break;

            default:
                ackResponseId = ackResponse?.id;
                parentId = ackResponse?.id;
        }

        return [ackResponseId, parentId];
    }

    private async processCommand(
        commandType: CommandType,
        context: {
            prepareContext: any;
            organizationAndTeamData: OrganizationAndTeamData;
            thread: any;
        },
    ): Promise<string> {
        switch (commandType) {
            case CommandType.BUSINESS_LOGIC_VALIDATION:
                return await this.handleBusinessLogicValidation(context);
            case CommandType.BUSINESS_LOGIC_INVALID_CONTEXT:
                return ACKNOWLEDGMENT_MESSAGES.BUSINESS_LOGIC_INVALID_CONTEXT;
            case CommandType.CONVERSATION:
                return await this.handleConversation(context);
            default:
                return await this.handleConversation(context);
        }
    }

    private async handleBusinessLogicValidation(context: {
        prepareContext: any;
        organizationAndTeamData: OrganizationAndTeamData;
        thread: any;
    }): Promise<string> {
        return await this.businessRulesValidationAgentUseCase.execute(context);
    }

    private async handleConversation(context: {
        prepareContext: any;
        organizationAndTeamData: OrganizationAndTeamData;
        thread: any;
    }): Promise<string> {
        const { prepareContext, organizationAndTeamData, thread } = context;

        // Acquire a sandbox lease for the duration of the conversation turn.
        // Same prKey as review → warm-resume reuse when both run on the same PR.
        // The lease lets the conversation agent invoke native tools (grep, readFile,
        // listDir, etc.) inside the sandbox so replies can reference real repo
        // content — not just MCP tools. 5min TTL covers LLM + comment posting.
        const prKey = buildPrKey(
            organizationAndTeamData.organizationId,
            prepareContext.repository?.id ?? 'unknown',
            prepareContext.pullRequest?.pullRequestNumber ?? 0,
        );

        // Resolve clone params so the lease manager can cold-create the sandbox
        // when this is the first acquire for this PR (no review ran yet, or this
        // PR has no automated review). Without these params the manager falls
        // back to NullSandbox and the agent loses native tools entirely.
        // When review acquired first, these params are simply ignored — the
        // existing sandbox is connected for warm-resume.
        const cloneParams = await this.buildSandboxCloneParams(
            prepareContext,
            organizationAndTeamData,
        );

        const { sandbox, leaseId } = await this.leaseManager.acquire(
            prKey,
            'conversation',
            5 * 60 * 1000,
            cloneParams,
        );

        try {
            return await this.conversationAgentUseCase.execute({
                prompt: prepareContext.userQuestion,
                organizationAndTeamData,
                prepareContext,
                thread,
                sandbox,
            });
        } finally {
            await this.leaseManager.release(leaseId);
        }
    }

    private async buildSandboxCloneParams(
        prepareContext: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CreateSandboxParams | undefined> {
        const repository = prepareContext.repository;
        const pr = prepareContext.pullRequest;
        const platform: PlatformType | undefined =
            prepareContext.platformType;

        if (!repository || !pr || !platform) {
            this.logger.warn({
                message:
                    'Cannot build sandbox clone params — missing repository/pullRequest/platform',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    hasRepository: !!repository,
                    hasPullRequest: !!pr,
                    platform,
                },
            });
            return undefined;
        }

        try {
            // Webhook payloads for `pull_request_review_comment` and
            // `issue_comment` give us { id, name, owner } but no `fullName`.
            // GitHub's getCloneParams builds the clone URL from `fullName`,
            // so we synthesize it here from owner/name when missing.
            const enrichedRepository =
                repository.fullName
                    ? repository
                    : {
                          ...repository,
                          fullName:
                              repository.owner && repository.name
                                  ? `${repository.owner}/${repository.name}`
                                  : repository.name,
                      };

            const cp = await this.codeManagementService.getCloneParams(
                {
                    repository: enrichedRepository,
                    organizationAndTeamData,
                },
                platform,
            );

            return {
                cloneUrl: cp.url,
                authToken: cp.auth?.token || '',
                authUsername: cp.auth?.username,
                branch: pr.headRef,
                baseBranch: pr.baseRef,
                prNumber: pr.pullRequestNumber,
                platform,
                sandboxMetadata: { stage: 'conversation' },
            };
        } catch (err) {
            // Auth lookup or repo metadata fetch failed — log and let the lease
            // manager fall back to NullSandbox. The agent still answers via
            // MCP-only tools (memory).
            this.logger.warn({
                message:
                    'Failed to resolve sandbox clone params; conversation will run without native tools',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    error: err instanceof Error ? err.message : String(err),
                },
            });
            return undefined;
        }
    }

    private getGitUser(params: WebhookParams): {
        id: number;
        username: string;
    } {
        const gitUser = {
            id: null,
            username: null,
        };

        switch (params.platformType) {
            case PlatformType.GITHUB:
                gitUser.id = params.payload?.comment?.user?.id;
                gitUser.username = params.payload?.comment?.user?.login;
                break;
            case PlatformType.GITLAB:
                gitUser.id = params.payload?.user?.id;
                gitUser.username = params.payload?.user?.username;
                break;
            case PlatformType.BITBUCKET:
                gitUser.id = params.payload?.comment?.user?.uuid;
                gitUser.username = params.payload?.comment?.user?.nickname;
                break;
            case PlatformType.AZURE_REPOS:
                gitUser.id = params.payload?.resource?.comment?.author?.id;
                gitUser.username =
                    params.payload?.resource?.comment?.author?.uniqueName;
                break;
            default:
                break;
        }

        if (!gitUser.id) {
            this.logger.warn({
                message: 'Unhandled platoformtype for manual issue creation',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: { params },
            });
        }
        return gitUser;
    }

    private extractCustomInstructions(
        params: WebhookParams,
    ): string | undefined {
        const payload = params.payload;
        const candidates: unknown[] = [
            payload?.customInstructions,
            payload?.custom_instructions,
            payload?.kody?.customInstructions,
            payload?.kody?.custom_instructions,
            payload?.configuration?.customInstructions,
            payload?.configuration?.custom_instructions,
            payload?.summary?.customInstructions,
            payload?.codeReviewConfig?.summary?.customInstructions,
            payload?.codeReview?.summary?.customInstructions,
        ];

        for (const candidate of candidates) {
            const normalized = this.normalizeCustomInstructions(candidate);
            if (normalized) {
                return normalized;
            }
        }

        return undefined;
    }

    private normalizeCustomInstructions(value: unknown): string | undefined {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }

        if (!value || typeof value !== 'object') {
            return undefined;
        }

        const record = value as Record<string, unknown>;
        const directTextCandidates = [
            record.text,
            record.value,
            record.content,
            record.body,
            record.instructions,
        ];
        for (const candidate of directTextCandidates) {
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
                return candidate.trim();
            }
        }

        return undefined;
    }
}
