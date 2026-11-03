import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CUSTOM_AGENT_RUN_LOG_TOKEN } from '@libs/code-review/domain/custom-agents/contracts';
import { CustomAgentRunRepository } from '@libs/code-review/infrastructure/adapters/repositories/custom-agent-run.repository';
import { CustomAgentRunModelInstance } from '@libs/code-review/infrastructure/adapters/repositories/schemas/mongoose/customAgentRun.model';

/**
 * How each custom agent run ended: written by the review (worker), read by
 * the agent's page (API).
 */
@Module({
    imports: [MongooseModule.forFeature([CustomAgentRunModelInstance])],
    providers: [
        CustomAgentRunRepository,
        {
            provide: CUSTOM_AGENT_RUN_LOG_TOKEN,
            useExisting: CustomAgentRunRepository,
        },
    ],
    exports: [CUSTOM_AGENT_RUN_LOG_TOKEN],
})
export class CustomAgentRunsModule {}
