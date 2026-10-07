import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { NotificationModule } from '@libs/notifications/modules/notification.module';

import { AgentSessionModelInstance } from '../infrastructure/persistence/schemas/agent-session.model';
import {
    CONVERSATION_STORE_TOKEN,
    MongoConversationStore,
} from '../infrastructure/persistence/mongo-conversation-store';

import { ConversationAgentUseCase } from '../application/use-cases/conversation-agent.use-case';
import { ConversationAgentProvider } from '../infrastructure/services/agents/conversation/conversationAgent';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { BusinessValidationService } from '../business-validation/business-validation.service';
import { BusinessValidationRunModelInstance } from '../business-validation/runs/validation-run.model';
import { ValidationRunRepository } from '../business-validation/runs/validation-run.repository';
import { BusinessLogicInsightsService } from '../business-validation/runs/insights.service';

@Module({
    imports: [
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => McpCoreModule),
        // Provides ByokErrorCounter so conversation/business report BYOK failures
        // (byok.llm_errors_threshold) — parity with code-review.
        forwardRef(() => NotificationModule),
        MongooseModule.forFeature([
            AgentSessionModelInstance,
            BusinessValidationRunModelInstance,
        ]),
    ],
    providers: [
        ConversationAgentUseCase,
        ConversationAgentProvider,
        SkillLoaderService,
        BusinessValidationService,
        ValidationRunRepository,
        BusinessLogicInsightsService,
        {
            provide: CONVERSATION_STORE_TOKEN,
            useClass: MongoConversationStore,
        },
    ],
    exports: [
        ConversationAgentUseCase,
        ConversationAgentProvider,
        SkillLoaderService,
        BusinessValidationService,
        ValidationRunRepository,
        BusinessLogicInsightsService,
        CONVERSATION_STORE_TOKEN,
    ],
})
export class AgentsModule {}
