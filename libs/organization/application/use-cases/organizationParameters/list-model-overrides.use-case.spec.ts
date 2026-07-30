import { ListModelOverridesUseCase } from './list-model-overrides.use-case';

const org = { organizationId: 'org-1' };

function build(opts: {
    codeReviewConfig: unknown;
    provider?: string;
    catalog?: Array<{ id: string; name: string }> | Error;
}) {
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue(
            opts.codeReviewConfig
                ? { configValue: opts.codeReviewConfig }
                : null,
        ),
    } as any;
    const orgParams = {
        findByKey: jest.fn().mockResolvedValue(
            opts.provider ? { configValue: { main: { provider: opts.provider } } } : null,
        ),
    } as any;
    const getModels = {
        execute: jest.fn(async () => {
            if (opts.catalog instanceof Error) throw opts.catalog;
            return { models: opts.catalog ?? [] };
        }),
    } as any;
    return new ListModelOverridesUseCase(orgParams, parametersService, getModels);
}

const cfgWith = (repoModel: string) => ({
    configs: {},
    repositories: [
        { id: 'r1', name: 'acme/api', configs: { byokModel: repoModel }, directories: [] },
    ],
});

describe('ListModelOverridesUseCase', () => {
    it('flags an override that is not in the current provider catalog as mismatched', async () => {
        const useCase = build({
            codeReviewConfig: cfgWith('gemini-3.1-pro'),
            provider: 'openai_compatible',
            catalog: [{ id: 'kimi-k2.7-code', name: 'Kimi' }],
        });

        const res = await useCase.execute(org);
        expect(res.provider).toBe('openai_compatible');
        expect(res.overrides[0].inCurrentProviderCatalog).toBe(false);
        expect(res.mismatchedCount).toBe(1);
    });

    it('marks an override in the catalog as matched (not mismatched)', async () => {
        const useCase = build({
            codeReviewConfig: cfgWith('kimi-k2.7-code'),
            provider: 'openai_compatible',
            catalog: [{ id: 'kimi-k2.7-code', name: 'Kimi' }],
        });

        const res = await useCase.execute(org);
        expect(res.overrides[0].inCurrentProviderCatalog).toBe(true);
        expect(res.mismatchedCount).toBe(0);
    });

    it('does not raise false alarms when the catalog is unavailable (null)', async () => {
        const useCase = build({
            codeReviewConfig: cfgWith('some-model'),
            provider: 'anthropic_compatible',
            catalog: new Error('listing unavailable'),
        });

        const res = await useCase.execute(org);
        expect(res.overrides[0].inCurrentProviderCatalog).toBeNull();
        expect(res.mismatchedCount).toBe(0);
    });

    it('does not flag a curated-provider (Bedrock/Vertex) miss as mismatched', async () => {
        const useCase = build({
            codeReviewConfig: cfgWith('us.anthropic.claude-3-5-haiku-20241022-v1:0'),
            provider: 'amazon_bedrock',
            catalog: [{ id: 'us.anthropic.claude-opus-4-8', name: 'Opus' }],
        });

        const res = await useCase.execute(org);
        // Curated list isn't exhaustive → can't judge → null, not false.
        expect(res.overrides[0].inCurrentProviderCatalog).toBeNull();
        expect(res.mismatchedCount).toBe(0);
    });

    it('short-circuits with no overrides', async () => {
        const useCase = build({ codeReviewConfig: { configs: {}, repositories: [] } });
        const res = await useCase.execute(org);
        expect(res.overrides).toEqual([]);
        expect(res.mismatchedCount).toBe(0);
    });
});
