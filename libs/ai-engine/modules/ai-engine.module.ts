import { ReferenceDetectorService } from '../infrastructure/adapters/services/reference-detector.service';
import { PromptContextEngineService } from '../infrastructure/adapters/services/prompt/promptContextEngine.service';
import { PromptContextLoaderService } from '../infrastructure/adapters/services/orchestration/promptContextLoader.service';
import { ContextReferenceDetectionService } from '../infrastructure/adapters/services/context/context-reference-detection.service';
import { ContextReferenceService } from '../infrastructure/adapters/services/context/context-reference.service';
import { ContextReferenceRepository } from '../infrastructure/adapters/repositories/contextReference.repository';
import { ContextReferenceModel } from '../infrastructure/adapters/repositories/schemas/contextReference.model';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN } from '../domain/prompt/contracts/promptContextEngine.contract';
import { PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN } from '../domain/prompt/contracts/promptExternalReferenceManager.contract';
import { PROMPT_CONTEXT_LOADER_SERVICE_TOKEN } from '../domain/prompt/contracts/promptContextLoader.contract';
import { forwardRef, Module } from '@nestjs/common';
import { CodeReviewContextPackService } from '../infrastructure/adapters/services/context/code-review-context-pack.service';
import { PromptExternalReferenceManagerService } from '../infrastructure/adapters/services/prompt/promptExternalReferenceManager.service';
import { CONTEXT_REFERENCE_SERVICE_TOKEN } from '../domain/contextReference/contracts/context-reference.service.contract';
import { CONTEXT_REFERENCE_REPOSITORY_TOKEN } from '../domain/contextReference/contracts/context-reference.repository.contract';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { AgentsModule } from '@libs/agents/modules/agents.module';

import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([ContextReferenceModel]),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => McpCoreModule), // For MCPToolMetadataService
        forwardRef(() => AgentsModule),
        forwardRef(() => PermissionValidationModule),
    ],
    providers: [
        ReferenceDetectorService,
        {
            provide: PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN,
            useClass: PromptContextEngineService,
        },
        {
            provide: PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN,
            useClass: PromptExternalReferenceManagerService,
        },
        {
            provide: PROMPT_CONTEXT_LOADER_SERVICE_TOKEN,
            useClass: PromptContextLoaderService,
        },
        {
            provide: CONTEXT_REFERENCE_SERVICE_TOKEN,
            useClass: ContextReferenceService,
        },
        {
            provide: CONTEXT_REFERENCE_REPOSITORY_TOKEN,
            useClass: ContextReferenceRepository,
        },
        CodeReviewContextPackService,
        ContextReferenceDetectionService,
        ContextReferenceService,
    ],
    exports: [
        ReferenceDetectorService,
        PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN,
        PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN,
        PROMPT_CONTEXT_LOADER_SERVICE_TOKEN,
        CONTEXT_REFERENCE_SERVICE_TOKEN,
        CodeReviewContextPackService,
        ContextReferenceDetectionService,
        ContextReferenceService,
    ],
})
export class AIEngineModule {}
