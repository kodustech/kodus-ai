import { Inject, Injectable } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { REQUEST } from '@nestjs/core';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    CONVERSATION_SERVICE_TOKEN,
    IConversationService,
} from '@/core/domain/conversation/contracts/conversation.service.contracts';
import {
    AGENT_SERVICE_TOKEN,
    IAgentService,
} from '@/core/domain/agents/contracts/agent.service.contracts';
import { cleanHumanMessages } from '@/shared/utils/helpers';

@Injectable()
export class ListConversationByIdUseCase implements IUseCase {
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
    ) {}

    async execute(id: string) {
        try {
            const userId = this.request.user?.uuid;
            const organizationId = this.request.user?.organization.uuid;

            const conversation = await this.conversationService.findById(
                id,
                userId,
                { organizationId },
            );

            const sessionId = conversation?.session?.uuid.toString();

            const memory = await this.agentService.getMemory(sessionId);

            return {
                uuid: conversation.uuid,
                title: conversation.title,
                type: conversation.type,
                messages: memory ? cleanHumanMessages(memory)?._messages : [],
                createdAt: conversation.createdAt,
                updatedAt: conversation.updatedAt,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error list conversation by id',
                context: ListConversationByIdUseCase.name,
                error: error,
                metadata: {
                    conversationId: id,
                },
            });
            throw error;
        }
    }
}
