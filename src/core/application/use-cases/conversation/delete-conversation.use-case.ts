import {
    CONVERSATION_SERVICE_TOKEN,
    IConversationService,
} from '@/core/domain/conversation/contracts/conversation.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class DeleteConversationUseCase implements IUseCase {
    constructor(
        @Inject(CONVERSATION_SERVICE_TOKEN)
        private readonly conversationService: IConversationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(uuid: string): Promise<boolean> {
        try {
            const response = await this.conversationService.delete(uuid);

            return response;
        } catch (error) {
            this.logger.error({
                message: 'Error delete conversation',
                context: DeleteConversationUseCase.name,
                error: error,
                metadata: { uuid },
            });
            throw error;
        }
    }
}
