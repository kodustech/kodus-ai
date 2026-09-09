/**
 * Kodus provider module — routing-brand behavior.
 *
 * What is pinned here and why:
 *  - the id grammar (`<upstream>/<model>`) and the CLOSED catalog: an unlisted
 *    id has no price, so it must be non-routable (capability gate) and
 *    unbuildable (build throws) — never a silent dispatch that cannot be billed;
 *  - the platform key comes from the DEDICATED env var, never the generic
 *    `API_ANTHROPIC_API_KEY` & co. (a self-hosted install's keys must never be
 *    billed as Kodus credits);
 *  - every protocol fact delegates to the upstream module under the upstream id
 *    with the bare model — the anthropic cache breakpoint being the one that
 *    matters most (it is what a gateway shim loses).
 */
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { REGISTRY } from '../index';
import { anthropicModule } from '../anthropic';
import { openaiModule } from '../openai';
import { googleGeminiModule } from '../google-gemini';
import {
    configuredKodusUpstreams,
    kodusModule,
    KODUS_UPSTREAM_KEY_ENV,
    splitKodusModelId,
} from './index';
import {
    isKodusCatalogModel,
    KODUS_CATALOG,
    kodusModelPricing,
} from './catalog';
import type { ProviderBuildConfig } from '../kernel/types';

const slot = (model: string): ProviderBuildConfig =>
    ({ provider: 'kodus', model, apiKey: '' }) as ProviderBuildConfig;

const ENV_KEYS = Object.values(KODUS_UPSTREAM_KEY_ENV);
const GENERIC_KEYS = [
    'API_ANTHROPIC_API_KEY',
    'API_OPEN_AI_API_KEY',
    'API_GOOGLE_AI_API_KEY',
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
    saved = {};
    for (const k of [...ENV_KEYS, ...GENERIC_KEYS]) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
});
afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe('registration', () => {
    it('is registered under `kodus` with no aliases and no UI fields', () => {
        expect(REGISTRY.get('kodus')).toBe(kodusModule);
        expect(kodusModule.aliases ?? []).toEqual([]);
        expect(kodusModule.uiFields).toEqual([]);
    });
});

describe('model id grammar', () => {
    it('splits <upstream>/<model> into the upstream provider id + bare model', () => {
        expect(splitKodusModelId('anthropic/claude-sonnet-5')).toEqual({
            upstream: 'anthropic',
            providerId: 'anthropic',
            model: 'claude-sonnet-5',
        });
        expect(splitKodusModelId('google/gemini-3.7-flash')).toEqual({
            upstream: 'google',
            providerId: 'google_gemini',
            model: 'gemini-3.7-flash',
        });
        // Only the FIRST slash splits — an upstream id may itself carry one.
        expect(splitKodusModelId('openai/org/model')?.model).toBe('org/model');
    });

    it('rejects unknown prefixes, missing slash, and empty halves', () => {
        expect(splitKodusModelId('deepseek/deepseek-v4')).toBeNull();
        expect(splitKodusModelId('claude-sonnet-5')).toBeNull();
        expect(splitKodusModelId('/claude-sonnet-5')).toBeNull();
        expect(splitKodusModelId('anthropic/')).toBeNull();
        expect(splitKodusModelId(undefined)).toBeNull();
    });
});

describe('catalog = price list', () => {
    it('every entry has a routable prefix and a full price', () => {
        for (const m of KODUS_CATALOG) {
            expect(splitKodusModelId(m.id)).not.toBeNull();
            expect(m.pricing?.inputPerMillion).toBeGreaterThan(0);
            expect(m.pricing?.outputPerMillion).toBeGreaterThan(0);
            expect(m.name).toBeTruthy();
        }
    });

    it('marks at least one recommended pick', () => {
        expect(KODUS_CATALOG.some((m) => m.recommended)).toBe(true);
    });

    it('answers pricing only for listed ids', () => {
        expect(kodusModelPricing('anthropic/claude-sonnet-5')).toBeDefined();
        expect(kodusModelPricing('anthropic/claude-sonnet-4-6')).toBeUndefined();
        expect(isKodusCatalogModel('openai/gpt-5.4')).toBe(true);
        expect(isKodusCatalogModel('openai/gpt-4o')).toBe(false);
    });

    it('lists the catalog statically under its own id only', () => {
        const listing = kodusModule.modelListing!('kodus');
        expect(listing?.kind).toBe('static');
        expect(kodusModule.modelListing!('anthropic')).toBeNull();
    });
});

describe('closed catalog: an unlisted id must not run', () => {
    it('capabilities() answers non-routable (fails every task gate)', () => {
        for (const id of [
            'anthropic/claude-sonnet-4-6',
            'deepseek/deepseek-v4',
            'gpt-5.4',
        ]) {
            const caps = kodusModule.capabilities(id);
            expect(caps.structuredOutput).toBe('none');
            expect(caps.toolCalling).toBe('none');
            expect(caps.supportsReasoning).toBe(false);
        }
    });

    it('build() refuses it, naming the id', () => {
        process.env.API_KODUS_PROVIDER_ANTHROPIC_API_KEY = 'k';
        expect(() => kodusModule.build(slot('anthropic/claude-sonnet-4-6'))).toThrow(
            /not in the Kodus catalog/,
        );
    });
});

describe('platform key resolution', () => {
    it('build() reads the DEDICATED env var and dispatches to the upstream module', () => {
        process.env.API_KODUS_PROVIDER_ANTHROPIC_API_KEY = 'sk-kodus-platform';
        const spy = jest.spyOn(anthropicModule, 'build');
        try {
            const model = kodusModule.build(slot('anthropic/claude-sonnet-5'), {
                structuredOutputs: true,
            });
            expect(model).toBeDefined();
            expect(spy).toHaveBeenCalledTimes(1);
            const [cfg, opts] = spy.mock.calls[0];
            expect(cfg.provider).toBe('anthropic');
            expect(cfg.model).toBe('claude-sonnet-5');
            expect(cfg.apiKey).toBe('sk-kodus-platform');
            expect(cfg.baseURL).toBeUndefined();
            expect(opts).toEqual({ structuredOutputs: true });
        } finally {
            spy.mockRestore();
        }
    });

    it('build() NEVER falls back to the generic provider keys', () => {
        process.env.API_ANTHROPIC_API_KEY = 'sk-self-hosted-customer-key';
        expect(() => kodusModule.build(slot('anthropic/claude-sonnet-5'))).toThrow(
            /API_KODUS_PROVIDER_ANTHROPIC_API_KEY/,
        );
    });

    it('drops org-supplied endpoint/cloud settings before delegating', () => {
        process.env.API_KODUS_PROVIDER_OPENAI_API_KEY = 'sk-kodus-openai';
        const spy = jest.spyOn(openaiModule, 'build');
        try {
            kodusModule.build({
                ...slot('openai/gpt-5.4'),
                baseURL: 'https://evil.example/v1',
                awsRegion: 'us-east-1',
            } as ProviderBuildConfig);
            const [cfg] = spy.mock.calls[0];
            expect(cfg.baseURL).toBeUndefined();
            expect((cfg as any).awsRegion).toBeUndefined();
            expect(cfg.provider).toBe('openai');
        } finally {
            spy.mockRestore();
        }
    });

    it('configuredKodusUpstreams() reports exactly the upstreams with a key', () => {
        expect(configuredKodusUpstreams()).toEqual([]);
        process.env.API_KODUS_PROVIDER_GOOGLE_API_KEY = 'g';
        process.env.API_KODUS_PROVIDER_ANTHROPIC_API_KEY = 'a';
        expect(configuredKodusUpstreams().sort()).toEqual(['anthropic', 'google']);
    });
});

describe('protocol facts delegate to the upstream under the upstream id', () => {
    const cases: Array<[string, typeof anthropicModule, string]> = [
        ['anthropic/claude-opus-5', anthropicModule, 'claude-opus-5'],
        ['openai/gpt-5.4', openaiModule, 'gpt-5.4'],
        ['google/gemini-3.7-flash', googleGeminiModule, 'gemini-3.7-flash'],
    ];

    it.each(cases)('%s: capabilities == upstream(bare)', (id, up, bare) => {
        expect(kodusModule.capabilities(id)).toEqual(up.capabilities(bare));
    });

    it.each(cases)('%s: reasoningTraits + temperaturePolicy', (id, up, bare) => {
        const upCfg = { provider: up.id, model: bare, apiKey: '' } as ProviderBuildConfig;
        expect(kodusModule.reasoningTraits(slot(id))).toEqual(up.reasoningTraits(upCfg));
        expect(kodusModule.temperaturePolicy(slot(id))).toEqual(
            up.temperaturePolicy(upCfg),
        );
    });

    it.each(cases)('%s: reasoning() for every effort', (id, up, bare) => {
        const upCfg = { provider: up.id, model: bare, apiKey: '' } as ProviderBuildConfig;
        for (const effort of ['none', 'low', 'medium', 'high'] as const) {
            expect(kodusModule.reasoning!(slot(id), effort)).toEqual(
                up.reasoning!(upCfg, effort),
            );
        }
    });

    it('providerOptionsNamespace is the UPSTREAM namespace (override wrapping)', () => {
        expect(kodusModule.providerOptionsNamespace!('kodus', 'anthropic/claude-opus-5')).toBe(
            'anthropic',
        );
        expect(kodusModule.providerOptionsNamespace!('kodus', 'openai/gpt-5.4')).toBe(
            'openai',
        );
        expect(kodusModule.providerOptionsNamespace!('kodus', 'google/gemini-3.7-flash')).toBe(
            'google',
        );
        expect(kodusModule.providerOptionsNamespace!('kodus', 'nope/x')).toBeUndefined();
    });

    it('Anthropic keeps its explicit ephemeral cache breakpoint; OpenAI/Gemini stay implicit', () => {
        expect(kodusModule.systemCacheControl!(slot('anthropic/claude-sonnet-5'))).toEqual({
            anthropic: { cacheControl: { type: 'ephemeral' } },
        });
        expect(kodusModule.systemCacheControl!(slot('openai/gpt-5.4'))).toBeUndefined();
        expect(kodusModule.systemCacheControl!(slot('google/gemini-3.7-flash'))).toBeUndefined();
        // promptCaching stays declared on every routed model.
        for (const m of KODUS_CATALOG) {
            expect(kodusModule.capabilities(m.id).promptCaching).toBe(true);
        }
    });

    it('a code-review-capable catalog: every listed model passes the review task gate', () => {
        for (const m of KODUS_CATALOG) {
            const caps = kodusModule.capabilities(m.id);
            expect(caps.structuredOutput !== 'none' || caps.toolCalling === 'native').toBe(
                true,
            );
        }
    });
});
