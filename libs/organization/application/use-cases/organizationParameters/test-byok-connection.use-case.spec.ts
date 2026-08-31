/**
 * Regression + contract: a key-only connect to an Anthropic-protocol BRAND
 * (Kimi/GLM, and any future one) must resolve the brand's canonical endpoint on
 * its own — the connect form carries no baseURL for a curated brand.
 *
 * Why this file exists: removing the curated catalog dropped `defaults.baseURL`,
 * and the connection probe — which had NO test — started throwing "baseURL is
 * required for moonshot". The coupling was indirect (catalog → web form → request
 * baseURL → probe), so a grep for direct `defaults.baseURL` readers missed it.
 * The endpoint now lives on the provider module (`defaultBaseURL`); this sweeps
 * EVERY brand that declares one, so a new brand is covered automatically and this
 * whole class of regression can't come back silently.
 *
 * The probe no longer builds requests itself — it hands a slot to
 * `probeSlotCall`, which runs the review's own montagem. So these assert what
 * this use-case is actually responsible for: the SLOT it assembles. That the
 * slot then produces the right request is `probe-slot-call.spec` plus the
 * provider modules' own specs.
 */
// @ts-nocheck

// 
import { REGISTRY } from '@libs/llm/providers';
import { TestByokConnectionUseCase } from './test-byok-connection.use-case';

jest.mock('dns/promises', () => ({
    lookup: jest
        .fn()
        .mockResolvedValue([{ address: '203.0.113.10', family: 4 }]),
}));

const probeSlotCall = jest.fn();
jest.mock('@libs/llm/probe-slot-call', () => ({
    probeSlotCall: (...args: any[]) => probeSlotCall(...args),
}));

// The slot carries ciphertext by contract; decryption happens in the model
// build. Stub the crypto so a test doesn't need a real key configured.
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => `enc(${v})`,
    decrypt: (v: string) => v,
}));

function useCase() {
    const providerService = { isProviderSupported: () => true } as any;
    return new TestByokConnectionUseCase(providerService);
}

const probedSlot = () => probeSlotCall.mock.calls[0][0];

// Every brand that declares a canonical endpoint — the exact set whose key-only
// connect depends on the module supplying baseURL. Derived from the registry, so
// a new brand joins this matrix the moment it ships.
const BRANDS_WITH_ENDPOINT = REGISTRY.all()
    .filter((m) => typeof m.defaultBaseURL === 'string' && m.defaultBaseURL)
    .map((m) => [m.id, m.defaultBaseURL as string] as const);

beforeEach(() => {
    probeSlotCall.mockReset();
    probeSlotCall.mockResolvedValue({ latencyMs: 12 });
});

describe('brands expose their canonical endpoint on the module', () => {
    it('at least the two Anthropic-protocol brands are present', () => {
        const ids = BRANDS_WITH_ENDPOINT.map(([id]) => id);
        expect(ids).toEqual(expect.arrayContaining(['moonshot', 'zai']));
    });

    it.each(BRANDS_WITH_ENDPOINT)(
        '%s → defaultBaseURL is a valid https URL',
        (_id, baseURL) => {
            expect(() => new URL(baseURL)).not.toThrow();
            expect(baseURL.startsWith('https://')).toBe(true);
        },
    );
});

describe('TestByokConnectionUseCase — key-only brand connect resolves the endpoint', () => {
    // The regression itself, swept over every brand: a key + NO baseURL must probe
    // the brand's own host, never throw "baseURL is required".
    it.each(BRANDS_WITH_ENDPOINT)(
        '%s: key-only (no baseURL) probes its own host, no 400',
        async (id, baseURL) => {
            const res = await useCase().execute({
                provider: id,
                apiKey: 'sk-test',
                model: 'some-model',
            });

            expect(res.ok).toBe(true);
            expect(probedSlot().baseURL).toBe(baseURL);
        },
    );

    it('a generic anthropic_compatible (no brand endpoint) still requires baseURL', async () => {
        await expect(
            useCase().execute({
                provider: 'anthropic_compatible',
                apiKey: 'sk-test',
                model: 'some-model',
            }),
        ).rejects.toThrow(/baseURL is required/i);
    });
});

// Fix 2 — the Test validates the configured tuning against the model's rules and
// returns a client error BEFORE any network round-trip, so a value the runtime
// would silently drop (an always-thinking Kimi ignores a non-1 temperature) fails
// the Test instead of saving quiet.
describe('TestByokConnectionUseCase — tuning validation short-circuits the probe', () => {
    it('kimi-k2.7-code + temperature 0.2 → bad_request, no call', async () => {
        const res = await useCase().execute({
            provider: 'novita',
            apiKey: 'sk-test',
            model: 'kimi-k2.7-code',
            temperature: 0.2,
        });
        expect(res.ok).toBe(false);
        expect(res.code).toBe('bad_request');
        expect(res.message).toContain('1');
        expect(probeSlotCall).not.toHaveBeenCalled();
    });

    it('kimi-k2.7-code + reasoningEffort "none" → bad_request, no call', async () => {
        const res = await useCase().execute({
            provider: 'anthropic_compatible',
            apiKey: 'sk-test',
            baseURL: 'https://api.moonshot.ai/anthropic',
            model: 'kimi-k2.7-code',
            reasoningEffort: 'none',
        });
        expect(res.ok).toBe(false);
        expect(res.code).toBe('bad_request');
        expect(probeSlotCall).not.toHaveBeenCalled();
    });

    it('kimi-k2.7-code + temperature 1 (matches the pin) → proceeds to probe', async () => {
        const res = await useCase().execute({
            provider: 'novita',
            apiKey: 'sk-test',
            model: 'kimi-k2.7-code',
            temperature: 1,
        });
        expect(res.ok).toBe(true);
        expect(probeSlotCall).toHaveBeenCalled();
    });
});

/**
 * The point of the refactor: the Test proves the config being SAVED. Every
 * field the save persists rides the probed slot, so a value the provider will
 * reject fails here rather than on the first review.
 */
describe('TestByokConnectionUseCase — the probe runs the config being saved', () => {
    it('carries the advanced settings, not just the key and model', async () => {
        await useCase().execute({
            provider: 'open_router',
            apiKey: 'sk-test',
            model: 'anthropic/claude-x',
            temperature: 0.3,
            reasoningEffort: 'high',
            reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
            maxOutputTokens: 2048,
            openrouterProviderOrder: ['anthropic'],
            openrouterAllowFallbacks: false,
        });

        expect(probedSlot()).toMatchObject({
            provider: 'open_router',
            model: 'anthropic/claude-x',
            temperature: 0.3,
            reasoningEffort: 'high',
            reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
            maxOutputTokens: 2048,
            openrouterProviderOrder: ['anthropic'],
            openrouterAllowFallbacks: false,
        });
    });

    it('hands the builder ciphertext, keeping the slot contract intact', async () => {
        await useCase().execute({
            provider: 'openai',
            apiKey: 'sk-plaintext',
            model: 'gpt-x',
        });

        expect(probedSlot().apiKey).toBe('enc(sk-plaintext)');
        expect(probedSlot().apiKey).not.toBe('sk-plaintext');
    });

    // A probe without a model could only answer "is the key valid?" — the weaker
    // question this refactor exists to stop answering.
    it('refuses to run without a model instead of testing something else', async () => {
        const res = await useCase().execute({
            provider: 'openai',
            apiKey: 'sk-test',
        });

        expect(res.ok).toBe(false);
        expect(res.code).toBe('bad_request');
        expect(res.message).toMatch(/model/i);
        expect(probeSlotCall).not.toHaveBeenCalled();
    });
});
