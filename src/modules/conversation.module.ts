import { UseCases } from '@/core/application/use-cases/conversation';
import { CONVERSATION_SERVICE_TOKEN } from '@/core/domain/conversation/contracts/conversation.service.contracts';
import { CONVERSATION_REPOSITORY_TOKEN } from '@/core/domain/conversation/contracts/conversations.repository.contracts';
import { ConversationRepository } from '@/core/infrastructure/adapters/repositories/mongoose/conversation.repository';
import { ConversationModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { ConversationService } from '@/core/infrastructure/adapters/services/conversation.service';
import { ConversationController } from '@/core/infrastructure/http/controllers/conversation.controller';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from './user.module';
import { SessionModule } from './session.module';
import { AgentModule } from './agent.module';
import { ParametersModule } from './parameters.module';

@Module({
    imports: [
        MongooseModule.forFeature([ConversationModelInstance]),
        UsersModule,
        SessionModule,
        AgentModule,
        ParametersModule,
    ],
    providers: [
        ...UseCases,
        {
            provide: CONVERSATION_REPOSITORY_TOKEN,
            useClass: ConversationRepository,
        },
        {
            provide: CONVERSATION_SERVICE_TOKEN,
            useClass: ConversationService,
        },
    ],
    exports: [CONVERSATION_REPOSITORY_TOKEN, CONVERSATION_SERVICE_TOKEN],
    controllers: [ConversationController],
})
export class ConversationModule {}
