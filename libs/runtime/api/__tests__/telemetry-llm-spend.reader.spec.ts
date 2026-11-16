import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';
import { TOKEN_USAGE_REPOSITORY_TOKEN } from '@libs/analytics/domain/token-usage/contracts/tokenUsage.repository.contract';
import type { RuntimeUsageRowContract } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import { SpendLimitConfigService } from '@libs/analytics/application/spend-limit/spend-limit-config.service';

import { TelemetryRuntimeLlmSpendReader, toRuntimeLlmSpendRow } from '../infrastructure/telemetry-llm-spend.reader';

// A Claude-like price list: a prompt above 200K input tokens is billed at the tier's rates, whole call.
const TIERED = {
    input: { default: 3e-6, tiers: [{ threshold: 200_000, rate: 6e-6 }] },
    output: { default: 15e-6, tiers: [{ threshold: 200_000, rate: 22.5e-6 }] },
    cacheRead: { default: 0.3e-6, tiers: [{ threshold: 200_000, rate: 0.6e-6 }] },
    cacheWrite: { default: 3.75e-6, tiers: [{ threshold: 200_000, rate: 7.5e-6 }] },
};
const tiered = { model: 'claude-sonnet-4-5', source: 'catalog' as const, priced: true, rates: TIERED };
const tier = (input: number, output: number, cacheRead = 0) => ({ input, output, total: input + output, outputReasoning: 0, cacheRead, cacheWrite: 0 });

const row = (patch: Partial<RuntimeUsageRowContract> = {}): RuntimeUsageRowContract => ({
    model: 'claude-sonnet-4-5',
    input: 400_000,
    output: 3_000,
    total: 403_000,
    outputReasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    byTier: [tier(100_000, 1_000), tier(300_000, 2_000)],
    runId: 'run-1',
    task: 'runtime.plan',
    runName: 'runtime.plan.model-turn',
    repositoryId: 'repo-1',
    isByok: false,
    ...patch,
});

describe('Runtime LLM spend from the usage spans', () => {
    it("prices a call whose prompt is above the model's threshold at that tier, not at the base rate", () => {
        const spent = toRuntimeLlmSpendRow(row(), tiered);
        // 100K × 3 + 1K × 15 (base) + 300K × 6 + 2K × 22.5 (above 200K), per million.
        expect(spent.usd).toBe(2.16);
        expect(spent.aboveBaseTierTokens).toBe(302_000);
        expect(spent).toMatchObject({ runId: 'run-1', agent: 'run_agent', paidBy: 'kodus', totalTokens: 403_000 });
    });

    it('keeps a model the price list cannot price unpriced, and a BYOK call as the org\'s spend', () => {
        expect(toRuntimeLlmSpendRow(row({ model: 'in-house-llm', byTier: undefined }), { model: 'in-house-llm', source: 'none', priced: false, rates: TIERED }).usd).toBeNull();
        expect(toRuntimeLlmSpendRow(row({ isByok: true, agentName: 'RuntimeRecipeAuthor', task: 'runtime.recipe_author' }), tiered)).toMatchObject({ paidBy: 'customer', agent: 'recipe_author' });
    });

    it("reads through Token Usage's repository with the org's manual price, and says nothing is readable without it", async () => {
        const reads: unknown[] = [];
        const repository = { getRuntimeUsage: async (q: unknown) => (reads.push(q), [row({ model: 'in-house-llm', byTier: undefined, input: 1_000_000, output: 0, total: 1_000_000 })]) };
        const catalog = { execute: async () => ({ id: 'x', pricing: { input: { default: 0 }, output: { default: 0 }, cacheRead: { default: 0 }, cacheWrite: { default: 0 }, prompt: 0, completion: 0, internal_reasoning: 0 } }) };
        const spendLimits = { getConfig: async () => ({ modelPricing: { 'in-house-llm': { input: 2e-6, output: 0, cacheRead: 0, cacheWrite: 0 } } }) };
        const app = new Map<unknown, unknown>([
            [TOKEN_USAGE_REPOSITORY_TOKEN, repository],
            [PricingResolver, new PricingResolver(catalog as never)],
            [SpendLimitConfigService, spendLimits],
        ]);
        const moduleRef = {
            get: (token: unknown) => {
                if (!app.has(token)) throw new Error('not in this app');
                return app.get(token);
            },
        };
        const query = { organizationId: 'org-a', start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z'), runIds: ['run-1'] };

        const rows = await new TelemetryRuntimeLlmSpendReader(moduleRef as never).spendOf(query);

        expect(reads).toEqual([query]);
        expect(rows).toEqual([expect.objectContaining({ model: 'in-house-llm', usd: 2 })]);
        app.delete(TOKEN_USAGE_REPOSITORY_TOKEN);
        expect(await new TelemetryRuntimeLlmSpendReader(moduleRef as never).spendOf(query)).toBeUndefined();
    });

    it('leaves a row unpriced, not free, when the price list cannot be read', async () => {
        const app = new Map<unknown, unknown>([
            [TOKEN_USAGE_REPOSITORY_TOKEN, { getRuntimeUsage: async () => [row()] }],
            [PricingResolver, { resolve: async () => Promise.reject(new Error('catalog down')) }],
        ]);
        const moduleRef = {
            get: (token: unknown) => {
                if (!app.has(token)) throw new Error('not in this app');
                return app.get(token);
            },
        };

        const rows = await new TelemetryRuntimeLlmSpendReader(moduleRef as never).spendOf({ organizationId: 'org-a', start: new Date(0), end: new Date() });

        expect(rows).toEqual([expect.objectContaining({ model: 'claude-sonnet-4-5', usd: null })]);
    });
});
