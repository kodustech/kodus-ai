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

/** The nine BYOKProvider ids the registry must fully cover after 01-02. */
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
    // bedrock authenticates via aws* fields, not apiKey — give it a bearer token.
    runStaticConformance(bedrockModule, {
        provider: 'amazon_bedrock',
        model: 'anthropic.claude-sonnet-4-20250514-v1:0',
    });
});

describe('registry covers all nine BYOKProvider ids (01-02 done)', () => {
    it('every id resolves to a registered module', () => {
        for (const id of ALL_IDS) {
            expect(REGISTRY.has(id)).toBe(true);
            expect(REGISTRY.get(id)).toBeDefined();
        }
    });
    it('registers exactly 7 distinct module objects for the 9 ids', () => {
        expect(REGISTRY.all().length).toBe(7);
        expect(new Set(REGISTRY.ids())).toEqual(new Set(ALL_IDS));
    });
});
