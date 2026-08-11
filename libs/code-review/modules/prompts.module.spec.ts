import { Test } from '@nestjs/testing';
import { PromptsModule } from './prompts.module';
import { LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN } from '../pipeline/stages/contracts/loadExternalContextStage.contract';
import { PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptContextEngine.contract';
import { PROMPT_CONTEXT_LOADER_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptContextLoader.contract';
import { PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';
import { CodeReviewContextPackService } from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context-pack.service';
import { BuildTraceContextPackUseCase } from '@libs/cli-review/application/use-cases/build-trace-context-pack.use-case';
import { LoadExternalContextStage } from '../pipeline/stages/load-external-context.stage';

function mockEmptyModule(exportName: string) {
    return () => {
        const { Module } = require('@nestjs/common');
        class EmptyModule {}
        Module({})(EmptyModule);
        return { [exportName]: EmptyModule };
    };
}

jest.mock(
    '@libs/code-review/modules/contextReference.module',
    mockEmptyModule('ContextReferenceModule'),
);
jest.mock(
    '@libs/integrations/modules/config.module',
    mockEmptyModule('IntegrationConfigModule'),
);
jest.mock(
    '@libs/platform/modules/platform.module',
    mockEmptyModule('PlatformModule'),
);
jest.mock('@libs/feature-gate/modules/feature-gate.module', () => {
    const { Module } = require('@nestjs/common');
    const {
        FeatureGateService,
    } = require('@libs/feature-gate/application/feature-gate.service');
    class MockFeatureGateModule {}
    Module({
        providers: [
            {
                provide: FeatureGateService,
                useValue: { isEnabled: jest.fn().mockResolvedValue(false) },
            },
        ],
        exports: [FeatureGateService],
    })(MockFeatureGateModule);
    return { FeatureGateModule: MockFeatureGateModule };
});
jest.mock('@libs/organization/modules/organization.module', () => {
    const { Module } = require('@nestjs/common');
    const {
        ORGANIZATION_SERVICE_TOKEN,
    } = require('@libs/organization/domain/organization/contracts/organization.service.contract');
    class MockOrganizationModule {}
    Module({
        providers: [
            {
                provide: ORGANIZATION_SERVICE_TOKEN,
                useValue: {
                    getReleaseTrack: jest.fn().mockResolvedValue('beta'),
                },
            },
        ],
        exports: [ORGANIZATION_SERVICE_TOKEN],
    })(MockOrganizationModule);
    return { OrganizationModule: MockOrganizationModule };
});
jest.mock('@libs/ai-engine/modules/ai-engine.module', () => {
    const { Module } = require('@nestjs/common');
    const {
        CodeReviewContextPackService,
    } = require('@libs/ai-engine/infrastructure/adapters/services/context/code-review-context-pack.service');
    class MockAIEngineModule {}
    Module({
        providers: [{ provide: CodeReviewContextPackService, useValue: {} }],
        exports: [CodeReviewContextPackService],
    })(MockAIEngineModule);
    return { AIEngineModule: MockAIEngineModule };
});
jest.mock('@libs/cli-review/trace-context.module', () => {
    const { Module } = require('@nestjs/common');
    const {
        BuildTraceContextPackUseCase,
    } = require('@libs/cli-review/application/use-cases/build-trace-context-pack.use-case');
    class MockTraceContextModule {}
    Module({
        providers: [{ provide: BuildTraceContextPackUseCase, useValue: {} }],
        exports: [BuildTraceContextPackUseCase],
    })(MockTraceContextModule);
    return { TraceContextModule: MockTraceContextModule };
});

describe('PromptsModule Trace wiring', () => {
    it('compiles and resolves LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN with Trace available', async () => {
        const module = await Test.createTestingModule({
            imports: [PromptsModule],
        })
            .overrideProvider(PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN)
            .useValue({})
            .overrideProvider(PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN)
            .useValue({
                getExternalReferences: jest.fn().mockResolvedValue([]),
            })
            .overrideProvider(PROMPT_CONTEXT_LOADER_SERVICE_TOKEN)
            .useValue({ loadExternalContext: jest.fn() })
            .overrideProvider(CodeReviewContextPackService)
            .useValue({ buildContextPack: jest.fn() })
            .overrideProvider(BuildTraceContextPackUseCase)
            .useValue({
                execute: jest.fn().mockResolvedValue({ decisions: [] }),
            })
            .compile();

        expect(module.get(LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN)).toBeInstanceOf(
            LoadExternalContextStage,
        );

        await module.close();
    });
});
