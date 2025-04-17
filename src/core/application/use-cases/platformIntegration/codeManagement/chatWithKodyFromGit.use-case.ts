import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { AGENT_SERVICE_TOKEN } from '@/core/domain/agents/contracts/agent.service.contracts';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import { AgentService } from '@/core/infrastructure/adapters/services/agent/agent.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

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
    user?: { login: string };
    author?: { name: string };
    diff_hunk?: string;
    discussion_id?: string;
    originalCommit?: any;
}

@Injectable()
export class ChatWithKodyFromGitUseCase {
    constructor(
        private readonly logger: PinoLoggerService,
        private readonly codeManagementService: CodeManagementService,
        @Inject(AGENT_SERVICE_TOKEN)
        private readonly agentService: AgentService,
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

            const integrationConfig = await this.getIntegrationConfig(params);
            const organizationAndTeamData =
                this.extractOrganizationAndTeamData(integrationConfig);
            const repository = this.getRepository(params);
            const pullRequestNumber = this.getPullRequestNumber(params);
            const allComments =
                await this.codeManagementService.getPullRequestReviewComment({
                    organizationAndTeamData,
                    filters: {
                        pullRequestNumber,
                        repository,
                        discussionId:
                            params.payload?.object_attributes?.discussion_id ??
                            '',
                    },
                });

            const commentId = this.getCommentId(params);
            const comment = allComments?.find((c) => c.id === commentId);

            if (this.shouldIgnoreComment(comment, params.platformType)) {
                this.logger.log({
                    message:
                        'Comment made by Kody or does not mention Kody/Kodus. Ignoring.',
                    context: ChatWithKodyFromGitUseCase.name,
                });
                return;
            }

            const originalKodyComment = this.getOriginalKodyComment(
                comment,
                allComments,
                params.platformType,
            );
            const othersReplies = this.getOthersReplies(
                comment,
                allComments,
                params.platformType,
            );
            const sender = this.getSender(params);

            const message = this.prepareMessage(
                comment,
                originalKodyComment,
                sender.login,
                othersReplies,
            );
            const response = await this.agentService.conversationWithKody(
                organizationAndTeamData,
                sender.id,
                message,
                sender.login,
            );

            await this.codeManagementService.createResponseToComment({
                organizationAndTeamData,
                inReplyToId: comment.id,
                discussionId: params.payload?.object_attributes?.discussion_id,
                body: response,
                repository,
                prNumber: pullRequestNumber,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error while executing the git comment response agent',
                context: ChatWithKodyFromGitUseCase.name,
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

    private async getIntegrationConfig(
        params: WebhookParams,
    ): Promise<IntegrationConfigEntity> {
        return await this.codeManagementService.findTeamAndOrganizationIdByConfigKey(
            {
                repository:
                    params.platformType === PlatformType.GITHUB
                        ? params.payload?.repository
                        : params.payload?.project,
            },
            params.platformType,
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
        return {
            name:
                params.platformType === PlatformType.GITHUB
                    ? params.payload?.repository?.name
                    : params.payload?.project?.name,
            id:
                params.platformType === PlatformType.GITHUB
                    ? params.payload?.repository?.id
                    : params.payload?.project?.id,
        };
    }

    private getPullRequestNumber(params: WebhookParams): number {
        return params.platformType === PlatformType.GITHUB
            ? params.payload?.pull_request?.number
            : params.payload?.merge_request?.iid;
    }

    private getCommentId(params: WebhookParams): number {
        return params.platformType === PlatformType.GITHUB
            ? params.payload?.comment?.id
            : params.payload?.object_attributes?.id;
    }

    private shouldIgnoreComment(
        comment: Comment,
        platformType: PlatformType,
    ): boolean {
        return (
            this.isKodyComment(comment, platformType) ||
            !this.mentionsKody(comment, platformType)
        );
    }

    private getOriginalKodyComment(
        comment: Comment,
        allComments: Comment[],
        platformType: PlatformType,
    ): Comment | undefined {
        return platformType === PlatformType.GITHUB
            ? allComments.find(
                  (originalComment) =>
                      originalComment.id === comment?.in_reply_to_id &&
                      this.isKodyComment(originalComment, platformType),
              )
            : comment?.originalCommit;
    }

    private getOthersReplies(
        comment: Comment,
        allComments: Comment[],
        platformType: PlatformType,
    ): Comment[] {
        return allComments.filter(
            (reply) =>
                reply.in_reply_to_id === comment.in_reply_to_id &&
                !this.isKodyComment(reply, platformType),
        );
    }

    private getSender(params: WebhookParams): Sender {
        return {
            login:
                params.platformType === PlatformType.GITHUB
                    ? params.payload.sender.login
                    : params.payload.user.name,
            id:
                params.platformType === PlatformType.GITHUB
                    ? params.payload.sender.id
                    : params.payload.user.id,
        };
    }

    private prepareMessage(
        comment: Comment,
        originalKodyComment: Comment,
        userName: string,
        othersReplies: Comment[],
    ): string {
        const userQuestion =
            comment.body.trim() === '@kody'
                ? 'The user did not ask any questions. Ask them what they would like to know about the codebase or suggestions for code changes.'
                : comment.body;

        return JSON.stringify({
            userName,
            userQuestion,
            context: {
                originalComment: {
                    text: originalKodyComment?.body,
                    diffHunk: originalKodyComment?.diff_hunk,
                },
                othersReplies: othersReplies.map((reply) => ({
                    text: reply.body,
                    diffHunk: reply.diff_hunk,
                })),
            },
        });
    }

    private mentionsKody(
        comment: Comment,
        platformType: PlatformType,
    ): boolean {
        const commentBody = comment.body.toLowerCase();
        return ['@kody', '@kodus'].some((keyword) =>
            commentBody.startsWith(keyword),
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

        return (
            ['kody', 'kodus'].some((keyword) => login?.includes(keyword)) ||
            body.includes('kody-codereview')
        );
    }
}
