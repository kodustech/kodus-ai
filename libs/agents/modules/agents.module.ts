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

import { BusinessRulesValidationAgentUseCase } from '../application/use-cases/business-rules-validation-agent.use-case';
import { ConversationAgentUseCase } from '../application/use-cases/conversation-agent.use-case';
import { BusinessRulesValidationAgentProvider } from '../infrastructure/services/agents/business-rules-validation/businessRulesValidationAgent';
import { ConversationAgentProvider } from '../infrastructure/services/agents/conversationAgent';
import { LLMModule } from '@kodus/kodus-common/llm';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { GenericSkillRunnerService } from '../skills/generic-skill-runner.service';
import { CapabilityStrategyService } from '../skills/runtime/capability-strategy.service';
import { CapabilityResourcePlanService } from '../skills/runtime/capability-resource-plan.service';

@Module({
    imports: [
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => ParametersModule),
        LLMModule,
        forwardRef(() => McpCoreModule),
        // Provides ByokErrorCounter so conversation/business report BYOK failures
        // (byok.llm_errors_threshold) — parity with code-review.
        forwardRef(() => NotificationModule),
        MongooseModule.forFeature([AgentSessionModelInstance]),
    ],
    providers: [
        BusinessRulesValidationAgentUseCase,
        ConversationAgentUseCase,
        BusinessRulesValidationAgentProvider,
        ConversationAgentProvider,
        SkillLoaderService,
        GenericSkillRunnerService,
        CapabilityStrategyService,
        CapabilityResourcePlanService,
        {
            provide: CONVERSATION_STORE_TOKEN,
            useClass: MongoConversationStore,
        },
    ],
    exports: [
        BusinessRulesValidationAgentUseCase,
        ConversationAgentUseCase,
        BusinessRulesValidationAgentProvider,
        ConversationAgentProvider,
        SkillLoaderService,
        GenericSkillRunnerService,
        CapabilityStrategyService,
        CapabilityResourcePlanService,
        CONVERSATION_STORE_TOKEN,
    ],
})
export class AgentsModule {}
