import {
    CONVERSATION_SERVICE_TOKEN,
    IConversationService,
} from '@/core/domain/conversation/contracts/conversation.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class UpdateConversationTitleUseCase implements IUseCase {
    constructor(
        @Inject(CONVERSATION_SERVICE_TOKEN)
        private readonly conversationService: IConversationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(uuid: string, title: string): Promise<{ uuid: string }> {
        try {
            const updatedConversation =
                await this.conversationService.updateTitle(uuid, title);

            return { uuid: updatedConversation.uuid };
        } catch (error) {
            this.logger.error({
                message: 'Error update conversation title',
                context: UpdateConversationTitleUseCase.name,
                error: error,
                metadata: { uuid, title },
            });
            throw error;
        }
    }
}
