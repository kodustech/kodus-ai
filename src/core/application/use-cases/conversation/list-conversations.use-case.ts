import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { REQUEST } from '@nestjs/core';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    CONVERSATION_SERVICE_TOKEN,
    IConversationService,
} from '@/core/domain/conversation/contracts/conversation.service.contracts';
import { IConversation } from '@/core/domain/conversation/interfaces/conversation.interface';

@Injectable()
export class ListConversationsUseCase implements IUseCase {
    constructor(
        @Inject(CONVERSATION_SERVICE_TOKEN)
        private readonly conversationService: IConversationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(teamId: string) {
        try {
            const userId = this.request.user?.uuid;
            const organizationId = this.request.user.organization.uuid;

            if (!userId || !organizationId) {
                throw new BadRequestException();
            }

            const conversations =
                await this.conversationService.findConverstionAndFormat(
                    userId,
                    {
                        organizationId,
                        teamId,
                    },
                );

            const transformedGroupedConversations = Object.fromEntries(
                Object.entries(conversations).map(([key, conversations]) => [
                    key,
                    conversations.map((conversation) => conversation.toJson()),
                ]),
            );

            return transformedGroupedConversations;
        } catch (error) {
            this.logger.error({
                message: 'Error list conversations',
                context: ListConversationsUseCase.name,
                error: error,
                metadata: { teamId },
            });
            throw error;
        }
    }
}
