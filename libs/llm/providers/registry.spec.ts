/**
 * Static conformance suite for ProviderModule (Phase 1, plan 01-01).
 *
 * `runStaticConformance(module)` asserts the module honors the contract WITHOUT
 * any network call: build returns a model object, settingsSchema round-trips,
 * capabilities is well-formed, reasoning maps every effort tier with 'none'→off.
 * 01-06 extracts this into a shared harness and loops it over REGISTRY.all().
 */
import type {
    ProviderBuildConfig,
    ProviderModule,
    ReasoningEffort,
} from './types';
import { REGISTRY, registerProvider } from './registry';
import './index'; // registers every ported module via side effect
import { openaiModule } from './openai.module';
import { anthropicModule } from './anthropic.module';
import { googleGeminiModule } from './google-gemini.module';
import { vertexModule } from './vertex.module';
import { openRouterModule } from './openrouter.module';
import { bedrockModule } from './bedrock.module';
import { novitaModule } from './novita.module';
import { moonshotModule } from './moonshot.module';
// D-05 registry-wide sweep (03-13): drive each module's real normalize boundary
// through the 03-01 conformance harness against its committed fixture.
import { runConformance, type ProviderFixture } from './conformance';
import { encrypt } from '@libs/common/utils/crypto';
import openaiReasoningFixture from './__fixtures__/openai/reasoning.json';
import anthropicReasoningFixture from './__fixtures__/anthropic/reasoning.json';
import googlePlainFixture from './__fixtures__/google/plain.json';
import vertexPlainFixture from './__fixtures__/vertex/plain.json';
import openRouterReasoningFixture from './__fixtures__/openrouter/reasoning.json';
import bedrockPlainFixture from './__fixtures__/bedrock/plain.json';
import novitaPlainFixture from './__fixtures__/novita/plain.json';
import moonshotPlainFixture from './__fixtures__/moonshot/plain.json';

/** The ten BYOKProvider ids the registry must fully cover (moonshot added). */
const ALL_IDS = [
    'openai',
    'openai_compatible',
    'anthropic',
    'anthropic_compatible',
    'google_gemini',
    'google_vertex',
    'open_router',
    'amazon_bedrock',
    'novita',
    'moonshot',
];

const EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high'];

/** A minimal build config for a given provider id + model (fake key — build()
 *  constructs the SDK client but makes no request). */
function sampleConfig(provider: string, model: string, baseURL?: string): ProviderBuildConfig {
    return {
        provider: provider as ProviderBuildConfig['provider'],
        apiKey: 'sk-test-key-not-real',
        model,
        ...(baseURL ? { baseURL } : {}),
    };
}

/**
 * Run the static-tier contract against one module. `sample` names a provider id
 * the module serves + a representative model (+ optional baseURL for compat ids).
 */
export function runStaticConformance(
    module: ProviderModule,
    sample: { provider: string; model: string; baseURL?: string; reasoningModel?: string },
): void {
    const cfg = sampleConfig(sample.provider, sample.model, sample.baseURL);

    it(`${module.id}: build() returns a model object (no network)`, () => {
        const model = module.build(cfg);
        expect(model).toBeDefined();
        expect(typeof model === 'object' || typeof model === 'string').toBe(true);
    });

    it(`${module.id}: settingsSchema round-trips valid settings`, () => {
        const settings = sample.baseURL ? { baseURL: sample.baseURL } : {};
        const parsed = module.settingsSchema.parse(settings);
        expect(parsed).toEqual(settings);
        // An empty object must be accepted (all settings optional at this tier).
        expect(() => module.settingsSchema.parse({})).not.toThrow();
    });

    it(`${module.id}: capabilities() is well-formed`, () => {
        const caps = module.capabilities(sample.reasoningModel ?? sample.model);
        expect(typeof caps.supportsTemperature).toBe('boolean');
        expect(typeof caps.supportsReasoning).toBe('boolean');
        if (caps.reasoningConfig) {
            expect(['level', 'budget', 'adaptive']).toContain(
                caps.reasoningConfig.type,
            );
            expect(caps.supportsReasoning).toBe(true);
        }
        // Extended execution capabilities (01-04) — every module populates them.
        expect(['json_schema', 'json_object', 'none']).toContain(
            caps.structuredOutput,
        );
        expect(['native', 'none']).toContain(caps.toolCalling);
        expect(['reasoning_split', 'output_only']).toContain(
            caps.usageGranularity,
        );
        expect(typeof caps.streaming).toBe('boolean');
        expect(typeof caps.promptCaching).toBe('boolean');
    });

    it(`${module.id}: reasoning() maps every effort tier; 'none' → off`, () => {
        if (!module.reasoning) return; // optional
        for (const effort of EFFORTS) {
            const opts = module.reasoning(cfg, effort);
            expect(opts).toBeDefined();
            expect(typeof opts).toBe('object');
            if (effort === 'none') {
                expect(Object.keys(opts)).toHaveLength(0);
            }
        }
    });

    it(`${module.id}: transformRequest is idempotent when present`, () => {
        if (!module.transformRequest) return; // optional
        const once = module.transformRequest(cfg);
        const twice = module.transformRequest(once);
        expect(twice).toEqual(once);
    });
}

describe('ProviderRegistry', () => {
    it('registers the openai module under openai + openai_compatible', () => {
        expect(REGISTRY.has('openai')).toBe(true);
        expect(REGISTRY.has('openai_compatible')).toBe(true);
        expect(REGISTRY.get('openai')).toBe(openaiModule);
        expect(REGISTRY.get('openai_compatible')).toBe(openaiModule);
    });

    it('throws a clear per-provider error on an unknown id', () => {
        expect(() => REGISTRY.get('does_not_exist')).toThrow(
            /no provider module registered for id "does_not_exist"/,
        );
    });

    it('rejects double-registration of an id by a different module', () => {
        const clash: ProviderModule = { ...openaiModule, id: 'openai', aliases: [] };
        expect(() => registerProvider(clash)).toThrow(/already registered/);
    });
});

describe('openai module — static conformance', () => {
    // native openai (reasoning path uses openai.reasoningEffort)
    runStaticConformance(openaiModule, {
        provider: 'openai',
        model: 'gpt-4o',
        reasoningModel: 'o3-mini',
    });
    // openai_compatible (baseURL-driven; reasoning uses openaiCompatible.thinking)
    runStaticConformance(openaiModule, {
        provider: 'openai_compatible',
        model: 'kimi-k2.7-code',
        baseURL: 'https://host:8000/v1',
    });
});

describe('01-02 ported modules — static conformance', () => {
    runStaticConformance(anthropicModule, {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        reasoningModel: 'claude-sonnet-4-6',
    });
    runStaticConformance(anthropicModule, {
        provider: 'anthropic_compatible',
        model: 'kimi-k2.7-code',
        baseURL: 'https://api.kimi.com/coding',
    });
    runStaticConformance(googleGeminiModule, {
        provider: 'google_gemini',
        model: 'gemini-2.5-pro',
        reasoningModel: 'gemini-2.5-pro',
    });
    runStaticConformance(vertexModule, {
        provider: 'google_vertex',
        model: 'gemini-2.5-pro',
    });
    runStaticConformance(openRouterModule, {
        provider: 'open_router',
        model: 'openai/gpt-4o',
        baseURL: 'https://openrouter.ai/api/v1',
    });
    runStaticConformance(novitaModule, {
        provider: 'novita',
        model: 'qwen/qwen-2.5-coder-32b-instruct',
        baseURL: 'https://api.novita.ai/v3/openai',
    });
    runStaticConformance(moonshotModule, {
        provider: 'moonshot',
        model: 'kimi-k2.7-code',
        baseURL: 'https://api.moonshot.ai/v1',
    });
    // bedrock authenticates via aws* fields, not apiKey — give it a bearer token.
    runStaticConformance(bedrockModule, {
        provider: 'amazon_bedrock',
        model: 'anthropic.claude-sonnet-4-20250514-v1:0',
    });
});

describe('registry covers all ten BYOKProvider ids', () => {
    it('every id resolves to a registered module', () => {
        for (const id of ALL_IDS) {
            expect(REGISTRY.has(id)).toBe(true);
            expect(REGISTRY.get(id)).toBeDefined();
        }
    });
    it('registers exactly 8 distinct module objects for the 10 ids', () => {
        expect(REGISTRY.all().length).toBe(8);
        expect(new Set(REGISTRY.ids())).toEqual(new Set(ALL_IDS));
    });
});

/**
 * Registry-wide conformance sweep (Phase 3, plan 03-13 — the FINAL D-05 gate).
 *
 * Iterates EVERY module registered in REGISTRY and drives its REAL normalize
 * boundary (build → SDK MockLanguageModelV4 → normalize/normalizeUsage) against a
 * committed fixture. This is the phase-wide guarantee that no module ever regresses
 * to the Phase 1 zero stub ({ input: 0, output: 0, reasoning: 0 }) and that reasoning
 * is a number that is a detail-OF output (never summed into, never subtracted from it).
 *
 * A representative fixture + build config per module id. A newly-registered module
 * with no entry here fails the coverage guard below — so add-a-provider forces
 * add-a-conformance-sample, keeping the sweep exhaustive.
 */
const CONFORMANCE_SAMPLES: Record<
    string,
    { cfg: ProviderBuildConfig; fixture: ProviderFixture }
> = {
    openai: {
        // openai_compatible Kimi/Moonshot reasoning call (reasoning split fixture).
        cfg: sampleConfig(
            'openai_compatible',
            'kimi-k2.7-code',
            'https://api.moonshot.ai/v1',
        ),
        fixture: openaiReasoningFixture as ProviderFixture,
    },
    anthropic: {
        cfg: sampleConfig('anthropic', 'claude-sonnet-4-5-20250929'),
        fixture: anthropicReasoningFixture as ProviderFixture,
    },
    google_gemini: {
        cfg: sampleConfig('google_gemini', 'gemini-2.5-flash'),
        fixture: googlePlainFixture as ProviderFixture,
    },
    google_vertex: {
        // vertexModelFromSaJson tolerates a bogus (non-SA-JSON) apiKey offline.
        cfg: {
            ...sampleConfig('google_vertex', 'gemini-2.5-flash'),
            apiKey: 'not-a-service-account-json',
            vertexLocation: 'global',
        } as ProviderBuildConfig,
        fixture: vertexPlainFixture as ProviderFixture,
    },
    open_router: {
        cfg: sampleConfig('open_router', 'moonshotai/kimi-k2-thinking'),
        fixture: openRouterReasoningFixture as ProviderFixture,
    },
    amazon_bedrock: {
        // bedrock build() DECRYPTS awsBearerToken, so feed it an encrypted token.
        cfg: {
            provider: 'amazon_bedrock',
            model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
            awsRegion: 'us-east-1',
            awsBearerToken: encrypt('offline-conformance-bearer'),
        } as unknown as ProviderBuildConfig,
        fixture: bedrockPlainFixture as ProviderFixture,
    },
    novita: {
        cfg: sampleConfig('novita', 'meta-llama/llama-3.1-70b-instruct'),
        fixture: novitaPlainFixture as ProviderFixture,
    },
    moonshot: {
        cfg: sampleConfig('moonshot', 'kimi-k2.7-code'),
        fixture: moonshotPlainFixture as ProviderFixture,
    },
};

describe('registry-wide conformance sweep (D-05): no module regresses to the zero stub', () => {
    const modules = REGISTRY.all();

    it('every registered module has a conformance sample (add-a-provider ⇒ add-a-sample)', () => {
        for (const module of modules) {
            expect(CONFORMANCE_SAMPLES[module.id]).toBeDefined();
        }
    });

    it('covers all 8 distinct registered modules', () => {
        expect(modules.length).toBe(8);
    });

    for (const module of modules) {
        const sample = CONFORMANCE_SAMPLES[module.id];
        if (!sample) continue; // absence is asserted by the coverage guard above
        const { cfg, fixture } = sample;
        const expectedReasoning =
            fixture.usage.outputTokenDetails?.reasoningTokens ??
            fixture.usage.reasoningTokens ??
            0;

        describe(`${module.id}`, () => {
            it('normalize/normalizeUsage return non-stub values through the real SDK boundary', async () => {
                const run = await runConformance(module, cfg, fixture);

                // Not the Phase 1 zero stub: the fixture carries non-zero counts,
                // so a real normalizeUsage must surface them.
                expect(run.usage.input).toBe(fixture.usage.inputTokens);
                expect(run.usage.output).toBe(fixture.usage.outputTokens);
                expect(run.usage.input).toBeGreaterThan(0);
                expect(run.usage.output).toBeGreaterThan(0);

                // reasoning is always a number, never null/undefined.
                expect(typeof run.usage.reasoning).toBe('number');
                expect(run.usage.reasoning).toBe(expectedReasoning);

                // Q4 double-count trap: reasoning is a detail-OF output — output
                // stays the FULL completion count, never summed-in nor subtracted.
                if (expectedReasoning > 0) {
                    expect(run.usage.reasoning).toBeGreaterThan(0);
                    expect(run.usage.output).not.toBe(
                        fixture.usage.outputTokens! - expectedReasoning,
                    );
                }

                // normalize(raw) mirrors normalizeUsage exactly and preserves raw.
                expect(run.result.usage).toEqual(run.usage);
                expect(run.result.raw).toBe(run.raw);
            });
        });
    }
});
