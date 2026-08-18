/**
 * Unit tests for the env / managed / self-host default-model resolution cascade.
 *
 * This file is the no-BYOK half of the single resolution funnel: when there is
 * no client slot, `resolveManagedSlot` decides which managed model + creds to
 * build, and `resolveEnvProvider` is the single-source prefix/key cascade that
 * both it and `getModelName` read. It was the one funnel primitive without a
 * dedicated spec (see the BYOK resolution audit), so these lock its branches.
 *
 * createOpenAICompatible is mocked so the two documented inline exceptions
 * (self-hosted / fireworks / deepseek) can be asserted by their config without
 * touching the real SDK.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
    resolveEnvProvider,
    resolveManagedSlot,
    hasManagedModelKey,
} from './managed-slot';
import { BYOKProvider } from './model-providers';

jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn((cfg: any) => {
        const factory = (model: string) => ({ __compat: cfg, model });
        return factory;
    }),
}));

// Every env var the cascade reads. Cleared before each test so a stray value
// from the developer's shell can't leak into an assertion, restored after.
const ENV_KEYS = [
    'API_LLM_PROVIDER_MODEL',
    'API_OPEN_AI_API_KEY',
    'API_OPENAI_FORCE_BASE_URL',
    'API_VERTEX_AI_API_KEY',
    'API_VERTEX_AI_LOCATION',
    'API_GOOGLE_AI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'API_FIREWORKS_API_KEY',
    'FIREWORKS_API_KEY',
    'API_FIREWORKS_BASE_URL',
    'API_DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY',
    'API_MOONSHOT_API_KEY',
    'MOONSHOT_API_KEY',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
    }
    (createOpenAICompatible as jest.Mock).mockClear();
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

describe('resolveEnvProvider — the self-hosted prefix/key cascade', () => {
    it('returns null in cloud (auto) mode', () => {
        // API_LLM_PROVIDER_MODEL unset → defaults to "auto".
        expect(resolveEnvProvider()).toBeNull();
        process.env.API_LLM_PROVIDER_MODEL = 'auto';
        expect(resolveEnvProvider()).toBeNull();
    });

    it('gemini-* + AI Studio key → google_ai_studio', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.API_GOOGLE_AI_API_KEY = 'aistudio-key';
        expect(resolveEnvProvider()).toEqual({
            kind: 'gemini_studio',
            name: 'google_ai_studio',
            apiKey: 'aistudio-key',
        });
    });

    it('gemini-* with only a Vertex key → google_vertex (with location)', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-flash';
        process.env.API_VERTEX_AI_API_KEY = 'vertex-sa-json';
        process.env.API_VERTEX_AI_LOCATION = 'us-east5';
        expect(resolveEnvProvider()).toEqual({
            kind: 'gemini_vertex',
            name: 'google_vertex',
            apiKey: 'vertex-sa-json',
            vertexLocation: 'us-east5',
        });
    });

    it('AI Studio key wins over Vertex key for gemini-*', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.API_GOOGLE_AI_API_KEY = 'studio';
        process.env.API_VERTEX_AI_API_KEY = 'vertex';
        expect(resolveEnvProvider()?.kind).toBe('gemini_studio');
    });

    it('claude-* + native OpenAI-slot key (no proxy) → anthropic native', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-4-5';
        process.env.API_OPEN_AI_API_KEY = 'sk-ant';
        expect(resolveEnvProvider()).toEqual({
            kind: 'claude_anthropic',
            name: 'anthropic',
            apiKey: 'sk-ant',
            baseURL: undefined,
        });
    });

    it('native Anthropic key takes precedence over Claude-on-Vertex', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-opus-4-5';
        process.env.API_OPEN_AI_API_KEY = 'sk-ant';
        process.env.API_VERTEX_AI_API_KEY = 'vertex';
        expect(resolveEnvProvider()?.kind).toBe('claude_anthropic');
    });

    it('claude-* with only a Vertex key → claude_vertex', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-3-5-sonnet';
        process.env.API_VERTEX_AI_API_KEY = 'vertex-sa';
        process.env.API_VERTEX_AI_LOCATION = 'us-central1';
        expect(resolveEnvProvider()).toMatchObject({
            kind: 'claude_vertex',
            name: 'google_vertex',
            apiKey: 'vertex-sa',
            vertexLocation: 'us-central1',
        });
    });

    it('any other model + OpenAI-style key → openai_compatible with default baseURL', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'llama-3.3-70b';
        process.env.API_OPEN_AI_API_KEY = 'sk-x';
        expect(resolveEnvProvider()).toEqual({
            kind: 'openai_compat',
            name: 'openai_compatible',
            apiKey: 'sk-x',
            baseURL: 'https://api.openai.com/v1',
        });
    });

    it('a forced proxy baseURL routes a gemini/claude id through openai_compatible', () => {
        // The proxy only speaks OpenAI chat; the prefix auto-detect must NOT
        // send it to Anthropic/Google native.
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-4-5';
        process.env.API_OPEN_AI_API_KEY = 'proxy-key';
        process.env.API_OPENAI_FORCE_BASE_URL = 'https://openrouter.ai/api/v1';
        expect(resolveEnvProvider()).toEqual({
            kind: 'openai_compat',
            name: 'openai_compatible',
            apiKey: 'proxy-key',
            baseURL: 'https://openrouter.ai/api/v1',
        });
    });

    it('an explicit api.anthropic.com baseURL stays Anthropic native', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-4-5';
        process.env.API_OPEN_AI_API_KEY = 'sk-ant';
        process.env.API_OPENAI_FORCE_BASE_URL = 'https://api.anthropic.com';
        expect(resolveEnvProvider()).toMatchObject({
            kind: 'claude_anthropic',
            baseURL: 'https://api.anthropic.com',
        });
    });

    it('self-hosted mode with no usable key → null (falls through to cloud default)', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        expect(resolveEnvProvider()).toBeNull();
    });
});

describe('resolveManagedSlot — env → managed slot / inline exception', () => {
    it('env gemini_studio → GOOGLE_GEMINI slot carrying the env model + plaintext key', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.API_GOOGLE_AI_API_KEY = 'studio-key';
        const r = resolveManagedSlot('unused-default', {});
        expect(r).toEqual({
            kind: 'slot',
            slot: {
                provider: BYOKProvider.GOOGLE_GEMINI,
                apiKey: 'studio-key',
                model: 'gemini-2.5-pro',
            },
        });
    });

    it('env vertex (gemini or claude) → the single GOOGLE_VERTEX slot with location', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-flash';
        process.env.API_VERTEX_AI_API_KEY = 'sa-json';
        process.env.API_VERTEX_AI_LOCATION = 'us-east5';
        const r = resolveManagedSlot('x', {});
        expect(r).toMatchObject({
            kind: 'slot',
            slot: {
                provider: BYOKProvider.GOOGLE_VERTEX,
                model: 'gemini-2.5-flash',
                vertexLocation: 'us-east5',
            },
        });
    });

    it('env claude_anthropic → ANTHROPIC slot (baseURL threaded)', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-4-5';
        process.env.API_OPEN_AI_API_KEY = 'sk-ant';
        const r = resolveManagedSlot('x', {});
        expect(r).toMatchObject({
            kind: 'slot',
            slot: {
                provider: BYOKProvider.ANTHROPIC,
                apiKey: 'sk-ant',
                model: 'claude-sonnet-4-5',
            },
        });
    });

    it('env openai_compat → INLINE exception built from the env baseURL/key', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'llama-3.3-70b';
        process.env.API_OPEN_AI_API_KEY = 'sk-x';
        const r = resolveManagedSlot('x', { structuredOutputs: true });
        expect(r.kind).toBe('inline');
        expect(createOpenAICompatible).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'self-hosted',
                apiKey: 'sk-x',
                baseURL: 'https://api.openai.com/v1',
                supportsStructuredOutputs: true,
            }),
        );
    });

    it('cloud + fireworks default model → INLINE fireworks (the managed default)', () => {
        process.env.API_FIREWORKS_API_KEY = 'fw-key';
        const r = resolveManagedSlot(
            'accounts/fireworks/models/deepseek-v4-flash-0731',
            {},
        );
        expect(r.kind).toBe('inline');
        expect(createOpenAICompatible).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'fireworks',
                apiKey: 'fw-key',
                baseURL: 'https://api.fireworks.ai/inference/v1',
                supportsStructuredOutputs: true,
            }),
        );
    });

    it('deepseek-* default → INLINE deepseek (legacy fallback)', () => {
        process.env.API_DEEPSEEK_API_KEY = 'ds-key';
        const r = resolveManagedSlot('deepseek-chat', {});
        expect(r.kind).toBe('inline');
        expect(createOpenAICompatible).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'deepseek', apiKey: 'ds-key' }),
        );
    });

    it('kimi-* default → MOONSHOT slot (routed through the registry, not inline)', () => {
        process.env.API_MOONSHOT_API_KEY = 'moon-key';
        const r = resolveManagedSlot('kimi-k2', {});
        expect(r).toEqual({
            kind: 'slot',
            slot: {
                provider: BYOKProvider.MOONSHOT,
                apiKey: 'moon-key',
                model: 'kimi-k2',
            },
        });
    });

    it('any other cloud default → GOOGLE_GEMINI slot', () => {
        process.env.API_GOOGLE_AI_API_KEY = 'g-key';
        const r = resolveManagedSlot('gemini-3-pro-preview', {});
        expect(r).toEqual({
            kind: 'slot',
            slot: {
                provider: BYOKProvider.GOOGLE_GEMINI,
                apiKey: 'g-key',
                model: 'gemini-3-pro-preview',
            },
        });
    });

    it('managed slots carry a PLAINTEXT env key — never an empty string when the key is set', () => {
        process.env.API_GOOGLE_AI_API_KEY = 'plain-key';
        const r = resolveManagedSlot('gemini-3-pro-preview', {});
        expect(r).toMatchObject({ slot: { apiKey: 'plain-key' } });
    });
});

describe('hasManagedModelKey — fail-soft skip-vs-run guard', () => {
    it('cloud: true only when a Fireworks key is present (the managed default)', () => {
        expect(hasManagedModelKey()).toBe(false);
        process.env.API_FIREWORKS_API_KEY = 'fw';
        expect(hasManagedModelKey()).toBe(true);
    });

    it('cloud: a stale DeepSeek key does NOT count (matches what Fireworks branch builds)', () => {
        process.env.API_DEEPSEEK_API_KEY = 'ds';
        expect(hasManagedModelKey()).toBe(false);
    });

    it('self-hosted: true when any relevant provider key is present', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        expect(hasManagedModelKey()).toBe(false);
        process.env.API_GOOGLE_AI_API_KEY = 'g';
        expect(hasManagedModelKey()).toBe(true);
    });
});
