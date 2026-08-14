import { Module, forwardRef } from '@nestjs/common';

import { ContextReferenceModule } from '@libs/code-review/modules/contextReference.module';
import { PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptContextEngine.contract';
import { PROMPT_CONTEXT_LOADER_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptContextLoader.contract';
import { PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';
import { LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN } from '@libs/code-review/pipeline/stages/contracts/loadExternalContextStage.contract';
import { LoadExternalContextStage } from '@libs/code-review/pipeline/stages/load-external-context.stage';
import { PromptContextEngineService } from '@libs/ai-engine/infrastructure/adapters/services/prompt/promptContextEngine.service';
import { PromptContextLoaderService } from '@libs/ai-engine/infrastructure/adapters/services/orchestration/promptContextLoader.service';
import { PromptExternalReferenceManagerService } from '@libs/ai-engine/infrastructure/adapters/services/prompt/promptExternalReferenceManager.service';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { AIEngineModule } from '@libs/ai-engine/modules/ai-engine.module';
import { TraceContextModule } from '@libs/cli-review/trace-context.module';
import { FeatureGateModule } from '@libs/feature-gate/modules/feature-gate.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';

@Module({
    imports: [
        forwardRef(() => PlatformModule),
        forwardRef(() => ContextReferenceModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => AIEngineModule),
        FeatureGateModule,
        forwardRef(() => OrganizationModule),
        TraceContextModule,
    ],
    providers: [
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
            provide: LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
            useClass: LoadExternalContextStage,
        },
    ],
    exports: [
        PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN,
        PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN,
        PROMPT_CONTEXT_LOADER_SERVICE_TOKEN,
        LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
    ],
})
export class PromptsModule {}
