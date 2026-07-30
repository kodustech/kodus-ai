import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PromptsModule } from '@libs/code-review/modules/prompts.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { ContextReferenceModel } from '@libs/ai-engine/infrastructure/adapters/repositories/schemas/contextReference.model';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { ContextReferenceService } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference.service';
import { ContextReferenceDetectionService } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference-detection.service';
import { CodeReviewContextPackService } from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context-pack.service';
import { MCPToolMetadataService } from '@libs/mcp-server/services/mcp-tool-metadata.service';
import { CONTEXT_REFERENCE_SERVICE_TOKEN } from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';
import { ContextReferenceRepository } from '@libs/ai-engine/infrastructure/adapters/repositories/contextReference.repository';
import { CONTEXT_REFERENCE_REPOSITORY_TOKEN } from '@libs/ai-engine/domain/contextReference/contracts/context-reference.repository.contract';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([ContextReferenceModel]),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => PromptsModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => McpCoreModule),
    ],
    providers: [
        ContextReferenceService,
        ContextReferenceDetectionService,
        CodeReviewContextPackService,
        MCPToolMetadataService,
        {
            provide: CONTEXT_REFERENCE_SERVICE_TOKEN,
            useExisting: ContextReferenceService,
        },
        {
            provide: CONTEXT_REFERENCE_REPOSITORY_TOKEN,
            useClass: ContextReferenceRepository,
        },
    ],
    exports: [
        ContextReferenceService,
        ContextReferenceDetectionService,
        CodeReviewContextPackService,
        MCPToolMetadataService,
        CONTEXT_REFERENCE_SERVICE_TOKEN,
        CONTEXT_REFERENCE_REPOSITORY_TOKEN,
    ],
})
export class ContextReferenceModule {}
