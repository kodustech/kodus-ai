import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { REQUEST } from '@nestjs/core';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    CONVERSATION_SERVICE_TOKEN,
    IConversationService,
} from '@/core/domain/conversation/contracts/conversation.service.contracts';
import { IConversation } from '@/core/domain/conversation/interfaces/conversation.interface';
import {
    AGENT_SERVICE_TOKEN,
    IAgentService,
} from '@/core/domain/agents/contracts/agent.service.contracts';

@Injectable()
export class SendMessageConversationUseCase implements IUseCase {
    constructor(
        @Inject(CONVERSATION_SERVICE_TOKEN)
        private readonly conversationService: IConversationService,

        @Inject(AGENT_SERVICE_TOKEN)
        private readonly agentService: IAgentService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },

        private logger: PinoLoggerService,
    ) { }

    async execute(params: any) {
        try {
            const { chatId, message, teamId } = params;
            const userId = this.request.user?.uuid;
            const organizationId = this.request.user?.organization.uuid;

            const conversation = await this.conversationService.findById(
                chatId,
                userId,
                { organizationId },
            );

            const sessionId = conversation?.session?.uuid.toString();

            const response = await this.agentService.conversationWithKody(
                {
                    teamId,
                    organizationId,
                },
                userId,
                message,
                undefined,
                sessionId,
            );

            return response;
        } catch (error) {
            this.logger.error({
                message: 'Error send message conversation',
                context: SendMessageConversationUseCase.name,
                error: error,
                metadata: { ...params },
            });
            throw error;
        }
    }
}
