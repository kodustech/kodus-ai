import axios from 'axios';

import { TokenPricingUseCase } from './token-pricing.use-case';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const LITELLM_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * models.dev fixture — provider-nested, prices in US$ per 1M tokens.
 * kimi-k2.6 is the issue's motivating case: bare id under a provider key.
 */
const modelsDevFixture = {
    moonshotai: {
        id: 'moonshotai',
        models: {
            'kimi-k2.6': {
                id: 'kimi-k2.6',
                cost: { input: 0.929, output: 3.858 },
            },
        },
    },
    google: {
        id: 'google',
        models: {
            'gemini-2.5-pro': {
                id: 'gemini-2.5-pro',
                cost: {
                    input: 1.25,
                    output: 10,
                    cache_read: 0.31,
                    tiers: [
                        {
                            input: 2.5,
                            output: 15,
                            cache_read: 0.25,
                            tier: { type: 'context', size: 200_000 },
                        },
                    ],
                    context_over_200k: {
                        input: 2.5,
                        output: 15,
                        cache_read: 0.25,
                    },
                },
            },
        },
    },
    openrouter: {
        id: 'openrouter',
        models: {
            'shared-model': {
                id: 'shared-model',
                cost: { input: 99, output: 99 },
            },
        },
    },
    zhipuai: {
        id: 'zhipuai',
        models: {
            'shared-model': {
                id: 'shared-model',
                cost: { input: 1, output: 2 },
            },
        },
    },
    // Multi-tier model: two context breakpoints, each with its own rate.
    aihubmix: {
        id: 'aihubmix',
        models: {
            'doubao-seed': {
                id: 'doubao-seed',
                cost: {
                    input: 0.48,
                    output: 2,
                    tiers: [
                        {
                            input: 0.72,
                            output: 3,
                            tier: { type: 'context', size: 32_000 },
                        },
                        {
                            input: 1.45,
                            output: 6,
                            tier: { type: 'context', size: 128_000 },
                        },
                    ],
                },
            },
        },
    },
    // A reseller enumerated BEFORE the vendor (`google-vertex` below),
    // exposing the same flagship id with only flat input/output (no tier, no
    // cache). The bare alias must NOT land here — it would strip the tier and
    // cache the vendor entry carries.
    '302ai': {
        id: '302ai',
        models: {
            'gemini-flagship': {
                id: 'gemini-flagship',
                cost: { input: 1.25, output: 10 },
            },
        },
    },
    // Native vendor, enumerated AFTER the reseller: same id, but with the
    // >200k tier and a cache-read rate. Richness must win the bare alias.
    'google-vertex': {
        id: 'google-vertex',
        models: {
            'gemini-flagship': {
                id: 'gemini-flagship',
                cost: {
                    input: 1.25,
                    output: 10,
                    cache_read: 0.31,
                    tiers: [
                        {
                            input: 2.5,
                            output: 15,
                            tier: { type: 'context', size: 200_000 },
                        },
                    ],
                },
            },
        },
    },
};

/** LiteLLM fixture — flat keys, prices already per-token. */
const liteLLMFixture = {
    'legacy-only-model': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 9e-6,
        litellm_provider: 'legacy',
    },
    'vertex_ai/gemini-1.5-pro-tiered': {
        input_cost_per_token: 1e-6,
        input_cost_per_token_above_200k_tokens: 2e-6,
        output_cost_per_token: 5e-6,
        litellm_provider: 'vertex_ai',
    },
};

const makeCache = () => {
    const store = new Map<string, unknown>();
    return {
        getFromCache: jest.fn(async (key: string) => store.get(key) ?? null),
        addToCache: jest.fn(async (key: string, value: unknown) => {
            store.set(key, value);
        }),
    };
};

const mockCatalogs = (opts?: { modelsDevFails?: boolean }) => {
    mockedAxios.get.mockImplementation(async (url: string) => {
        if (url === MODELS_DEV_URL) {
            if (opts?.modelsDevFails) throw new Error('models.dev down');
            return { data: modelsDevFixture };
        }
        if (url === LITELLM_URL) return { data: liteLLMFixture };
        throw new Error(`Unexpected URL ${url}`);
    });
};

describe('TokenPricingUseCase', () => {
    let useCase: TokenPricingUseCase;
    let cache: ReturnType<typeof makeCache>;

    beforeEach(() => {
        jest.clearAllMocks();
        cache = makeCache();
        useCase = new TokenPricingUseCase(cache as any);
    });

    it('resolves a bare model id against the provider-nested models.dev catalog, converting per-1M to per-token', async () => {
        mockCatalogs();

        const info = await useCase.execute('kimi-k2.6');

        expect(info.pricing.input.default).toBeCloseTo(0.929e-6, 12);
        expect(info.pricing.output.default).toBeCloseTo(3.858e-6, 12);
        expect(info.provider).toBe('moonshotai');
        // The motivating regression: this must never be "unpriced".
        expect(
            info.pricing.input.default > 0 || info.pricing.output.default > 0,
        ).toBe(true);
    });

    it('resolves provider-prefixed queries too', async () => {
        mockCatalogs();

        const info = await useCase.execute('moonshotai/kimi-k2.6');

        expect(info.pricing.input.default).toBeCloseTo(0.929e-6, 12);
    });

    it('maps models.dev tiers[].tier.size to a tiered per-token rate', async () => {
        mockCatalogs();

        const info = await useCase.execute('gemini-2.5-pro');

        expect(info.pricing.input).toEqual({
            default: 1.25e-6,
            tiers: [{ threshold: 200_000, rate: 2.5e-6 }],
        });
        expect(info.pricing.output.tiers).toEqual([
            { threshold: 200_000, rate: 15e-6 },
        ]);
        expect(info.pricing.cacheRead).toEqual({
            default: 0.31e-6,
            tiers: [{ threshold: 200_000, rate: 0.25e-6 }],
        });
    });

    it('falls back to the LiteLLM catalog for models missing from models.dev', async () => {
        mockCatalogs();

        const info = await useCase.execute('legacy-only-model');

        // LiteLLM prices are already per-token — no conversion.
        expect(info.pricing.input.default).toBe(3e-6);
        expect(info.pricing.output.default).toBe(9e-6);
        expect(info.provider).toBe('legacy');
    });

    it('still prices models when the models.dev fetch fails', async () => {
        mockCatalogs({ modelsDevFails: true });

        const info = await useCase.execute('legacy-only-model');

        expect(info.pricing.input.default).toBe(3e-6);
    });

    it('prefers a native provider over an aggregator for the bare-id alias', async () => {
        mockCatalogs();

        const info = await useCase.execute('shared-model');

        expect(info.provider).toBe('zhipuai');
        expect(info.pricing.input.default).toBeCloseTo(1e-6, 12);
    });

    // Regression: a reseller enumerated first exposed the same flagship id
    // with flat input/output only, and the bare alias landed on it — dropping
    // the >200k tier and the cache-read rate the vendor entry carries.
    it('resolves a flagship to the vendor entry that keeps tier + cache, not a flat reseller listed first', async () => {
        mockCatalogs();

        const info = await useCase.execute('gemini-flagship');

        expect(info.provider).toBe('google-vertex');
        // tier survived
        expect(info.pricing.input.tiers).toEqual([
            { threshold: 200_000, rate: 2.5e-6 },
        ]);
        expect(info.pricing.output.tiers?.[0]?.rate).toBeCloseTo(15e-6, 12);
        // cache rate survived
        expect(info.pricing.cacheRead.default).toBeCloseTo(0.31e-6, 12);
    });

    it('returns all-zero pricing for an unknown model', async () => {
        mockCatalogs();

        const info = await useCase.execute('does-not-exist-anywhere');

        expect(info.pricing.input.default).toBe(0);
        expect(info.pricing.output.default).toBe(0);
    });

    it('fetches each catalog at most once thanks to the cache', async () => {
        mockCatalogs();

        await useCase.execute('kimi-k2.6');
        await useCase.execute('gemini-2.5-pro');
        await useCase.executeMany(['kimi-k2.6', 'legacy-only-model']);

        const urls = mockedAxios.get.mock.calls.map((c) => c[0]);
        expect(urls.filter((u) => u === MODELS_DEV_URL)).toHaveLength(1);
        expect(urls.filter((u) => u === LITELLM_URL)).toHaveLength(1);
    });

    describe('tieredInputThresholds', () => {
        it('includes tiered models from both catalogs under every canonical name', async () => {
            mockCatalogs();

            const thresholds = await useCase.tieredInputThresholds();

            // models.dev tier (per-model size), bare and prefixed forms.
            expect(thresholds.get('gemini-2.5-pro')).toEqual([200_000]);
            expect(thresholds.get('google/gemini-2.5-pro')).toEqual([200_000]);
            // LiteLLM *_above_200k_tokens tier.
            expect(thresholds.get('gemini-1.5-pro-tiered')).toEqual([200_000]);
            expect(thresholds.get('vertex_ai/gemini-1.5-pro-tiered')).toEqual([
                200_000,
            ]);
            // Non-tiered models are absent.
            expect(thresholds.has('kimi-k2.6')).toBe(false);
        });

        it('carries every breakpoint for a multi-tier model, sorted', async () => {
            mockCatalogs();

            const thresholds = await useCase.tieredInputThresholds();

            // Doubao-style: two context breakpoints (32K + 128K).
            expect(thresholds.get('doubao-seed')).toEqual([32_000, 128_000]);
        });
    });

    it('builds a per-token tier list for a multi-tier (Doubao-style) model', async () => {
        mockCatalogs();

        const info = await useCase.execute('doubao-seed');

        expect(info.pricing.input.default).toBeCloseTo(0.48e-6, 12);
        const tiers = info.pricing.input.tiers!;
        expect(tiers).toHaveLength(2);
        expect(tiers[0].threshold).toBe(32_000);
        expect(tiers[0].rate).toBeCloseTo(0.72e-6, 12);
        expect(tiers[1].threshold).toBe(128_000);
        expect(tiers[1].rate).toBeCloseTo(1.45e-6, 12);
    });
});
