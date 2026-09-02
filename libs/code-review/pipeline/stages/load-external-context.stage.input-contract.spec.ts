import { Test, TestingModule } from '@nestjs/testing';

import { LoadExternalContextStage } from './load-external-context.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';
import { PROMPT_CONTEXT_LOADER_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptContextLoader.contract';
import { CodeReviewContextPackService } from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context-pack.service';
import { BuildTraceContextPackUseCase } from '@libs/cli-review/application/use-cases/build-trace-context-pack.use-case';
import { FeatureGateService } from '@libs/feature-gate';
import { ORGANIZATION_SERVICE_TOKEN } from '@libs/organization/domain/organization/contracts/organization.service.contract';

/**
 * Input-contract spec for LoadExternalContextStage — the stage that loads the
 * external prompt context the LLM review reads. Complements the existing
 * trace-gate spec: guards how references are looked up (org/repo/directory),
 * that the external context is loaded and written to `externalPromptContext`,
 * that it stays empty when there are no references, and that a load failure
 * degrades to an empty context (never throws). Trace loading is stubbed — it is
 * covered by load-external-context.stage.trace-gate.spec.ts.
 */
describe('LoadExternalContextStage — input contract', () => {
    let stage: LoadExternalContextStage;
    let refManager: { buildConfigKeysHierarchy: jest.Mock; findByConfigKeys: jest.Mock };
    let contextLoader: { loadExternalContext: jest.Mock };

    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const REPO = { id: 'repo-1', name: 'tiny-url' };
    const PR = { number: 42 };

    const buildContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ): CodeReviewPipelineContext =>
        ({
            organizationAndTeamData: ORG,
            repository: REPO,
            pullRequest: PR,
            codeReviewConfig: { directoryId: 'dir-1' },
            ...overrides,
        }) as unknown as CodeReviewPipelineContext;

    beforeEach(async () => {
        refManager = {
            buildConfigKeysHierarchy: jest.fn().mockReturnValue(['k1']),
            findByConfigKeys: jest.fn().mockResolvedValue([{ configKey: 'k1' }]),
        };
        contextLoader = {
            loadExternalContext: jest.fn().mockResolvedValue({
                externalContext: { foo: 1 },
                contextLayers: [],
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                LoadExternalContextStage,
                { provide: PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN, useValue: refManager },
                { provide: PROMPT_CONTEXT_LOADER_SERVICE_TOKEN, useValue: contextLoader },
                { provide: CodeReviewContextPackService, useValue: { buildContextPack: jest.fn() } },
                { provide: BuildTraceContextPackUseCase, useValue: {} },
                { provide: FeatureGateService, useValue: {} },
                { provide: ORGANIZATION_SERVICE_TOKEN, useValue: {} },
            ],
        }).compile();

        stage = module.get(LoadExternalContextStage);
        // Trace decisions are covered by the trace-gate spec — keep them out.
        jest.spyOn(stage as any, 'loadTraceDecisions').mockResolvedValue(undefined);
    });

    it('looks up references by the org/repo/directory hierarchy', async () => {
        await stage.execute(buildContext());

        expect(refManager.buildConfigKeysHierarchy).toHaveBeenCalledWith(
            ORG,
            REPO.id,
            'dir-1',
        );
    });

    it('loads the external context (with org/repo/pr + references) and stamps it on the context', async () => {
        const result = await stage.execute(buildContext());

        expect(contextLoader.loadExternalContext).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: ORG,
                repository: REPO,
                pullRequest: PR,
                allReferences: [{ configKey: 'k1' }],
            }),
            { buildLayers: true },
        );
        expect((result as any).externalPromptContext).toEqual({ foo: 1 });
    });

    it('leaves the external context EMPTY (no load) when there are no references', async () => {
        refManager.findByConfigKeys.mockResolvedValue([]);

        const result = await stage.execute(buildContext());

        expect(contextLoader.loadExternalContext).not.toHaveBeenCalled();
        expect((result as any).externalPromptContext).toEqual({});
    });

    it('degrades to an empty context (never throws) when reference lookup fails', async () => {
        refManager.findByConfigKeys.mockRejectedValue(new Error('lookup down'));

        const result = await stage.execute(buildContext());

        expect((result as any).externalPromptContext).toEqual({});
        expect((result as any).sharedContextPack).toBeUndefined();
    });
});
