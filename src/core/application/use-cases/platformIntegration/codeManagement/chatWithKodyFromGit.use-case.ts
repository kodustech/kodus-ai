import { Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ConversationAgentUseCase } from '../../agent/conversation-agent.use-case';
import { BusinessRulesValidationAgentUseCase } from '../../agent/business-rules-validation-agent.use-case';
import { createThreadId } from '@kodus/flow';
import posthogClient from '@/shared/utils/posthog';
// Constants
const KODY_COMMANDS = {
    BUSINESS_LOGIC_VALIDATION: '@kody -v business-logic',
    KODY_MENTION: '@kody',
    KODUS_MENTION: '@kodus',
} as const;
const KODY_IDENTIFIERS = {
    LOGIN_KEYWORDS: ['kody', 'kodus'],
    MARKDOWN_IDENTIFIERS: {
        DEFAULT: 'kody-codereview',
        BITBUCKET: 'kody|code-review',
    },
} as const;
const ACKNOWLEDGMENT_MESSAGES = {
    MARKDOWN_SUFFIX: '<!-- kody-codereview -->\n\u200b',
    BUSINESS_LOGIC_INVALID_CONTEXT:
        'The "@kody -v business-logic" command can only be used in the general PR conversation, not in code suggestions or inline comments. Please use it in the main PR discussion thread.',
} as const;
const PROCESSING_REACTIONS = {
    HOURGLASS: '⏳',
    EYES: '👀',
    THINKING: '🤔',
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
    private commandManager: CommandManager;
    constructor(
        private readonly logger: PinoLoggerService,
        private readonly codeManagementService: CodeManagementService,
        private readonly conversationAgentUseCase: ConversationAgentUseCase,
        private readonly businessRulesValidationAgentUseCase: BusinessRulesValidationAgentUseCase,
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
            const defaultBranch = this.getDefaultBranch(params, repository);
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
        if (
            (action && action !== 'created') ||
            (!action && eventType && eventType !== 'note')
        ) {
            return false;
        }
        return true;
    }
    private detectCommandType(params: WebhookParams): CommandType {
        if (params.platformType === PlatformType.GITHUB) {
            const isIssueComment = params.event === 'issue_comment';
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
        // Add processing reaction instead of interim message
        await this.addProcessingReaction({
            organizationAndTeamData,
            repository,
            pullRequestNumber,
            commentId: issueId,
            platformType: params.platformType,
        });
        const prepareContext = {
            userQuestion: commentBody,
            pullRequestNumber,
            repository,
            pullRequestDescription,
            platformType: params.platformType,
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
            // Remove processing reaction before returning
            await this.removeProcessingReaction({
                organizationAndTeamData,
                repository,
                pullRequestNumber,
                commentId: issueId,
                platformType: params.platformType,
            });
            return;
        }
        try {
            await this.codeManagementService.createIssueComment({
                organizationAndTeamData,
                repository,
                prNumber: pullRequestNumber,
                body: response,
            });
            this.logger.log({
                message:
                    'Successfully posted PR response for business logic validation',
                context: ChatWithKodyFromGitUseCase.name,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to post PR response for business logic validation',
                context: ChatWithKodyFromGitUseCase.name,
                error,
                metadata: {
                    repository: repository.name,
                    pullRequestNumber,
                },
            });
            return;
        } finally {
            // Always remove the processing reaction to prevent it from getting stuck
            await this.removeProcessingReaction({
                organizationAndTeamData,
                repository,
                pullRequestNumber,
                commentId: issueId,
                platformType: params.platformType,
            });
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
                        params.payload?.object_attributes?.discussion_id ?? '',
                },
            });
        const commentId = this.getCommentId(params);
        const comment =
            params.platformType !== PlatformType.AZURE_REPOS
                ? allComments?.find((c) => c.id === commentId)
                : this.getReviewThreadByCommentId(
                      commentId,
                      allComments,
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
                    pullRequestNumber
