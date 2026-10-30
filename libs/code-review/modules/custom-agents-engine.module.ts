import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
    CUSTOM_AGENT_KNOWLEDGE_READER_TOKEN,
    CUSTOM_AGENT_TOOL_CATALOG_TOKEN,
    CUSTOM_AGENT_TRY_RUNNER_TOKEN,
    CUSTOM_AGENT_TRY_RUN_STORE_TOKEN,
} from '@libs/code-review/domain/custom-agents/contracts';
import { CustomAgentTryRunRepository } from '@libs/code-review/infrastructure/adapters/repositories/custom-agent-try-run.repository';
import { CustomAgentTryRunModelInstance } from '@libs/code-review/infrastructure/adapters/repositories/schemas/mongoose/customAgentTryRun.model';
import {
    CustomAgentKnowledgeReaderService,
    CustomAgentToolCatalogService,
    CustomAgentTryRunnerService,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-seams.service';
import { CodeReviewPipelineModule } from '@libs/code-review/pipeline/code-review-pipeline.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';

import { CodebaseModule } from './codebase.module';
import { ReviewKnowledgeModule } from './review-knowledge.module';

/**
 * What the custom agent settings endpoints call into (#2172): reading skills
 * and docs from a repository, listing read-only plugin tools, and running an
 * agent on a pull request for Try it.
 */
@Module({
    imports: [
        // Try it runs are stored while the settings page polls for them.
        MongooseModule.forFeature([CustomAgentTryRunModelInstance]),
        forwardRef(() => PlatformModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => McpCoreModule),
        ReviewKnowledgeModule,
        // Try it runs the review's own pieces: the repository config, the
        // sandbox stage (CLI install) and the review orchestrator.
        forwardRef(() => CodebaseModule),
        forwardRef(() => CodeReviewPipelineModule),
    ],
    providers: [
        CustomAgentKnowledgeReaderService,
        CustomAgentToolCatalogService,
        CustomAgentTryRunnerService,
        CustomAgentTryRunRepository,
        {
            provide: CUSTOM_AGENT_KNOWLEDGE_READER_TOKEN,
            useExisting: CustomAgentKnowledgeReaderService,
        },
        {
            provide: CUSTOM_AGENT_TOOL_CATALOG_TOKEN,
            useExisting: CustomAgentToolCatalogService,
        },
        {
            provide: CUSTOM_AGENT_TRY_RUNNER_TOKEN,
            useExisting: CustomAgentTryRunnerService,
        },
        {
            provide: CUSTOM_AGENT_TRY_RUN_STORE_TOKEN,
            useExisting: CustomAgentTryRunRepository,
        },
    ],
    exports: [
        CUSTOM_AGENT_KNOWLEDGE_READER_TOKEN,
        CUSTOM_AGENT_TOOL_CATALOG_TOKEN,
        CUSTOM_AGENT_TRY_RUNNER_TOKEN,
        CUSTOM_AGENT_TRY_RUN_STORE_TOKEN,
    ],
})
export class CustomAgentsEngineModule {}
