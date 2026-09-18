/**
 * Env/managed reasoning coverage — the gap the BYOK-only specs missed.
 *
 * The self-hosted env path routes an `undefined` slot (no BYOK), so the routed
 * slot carries no provider/model. Before the fix, `defaultReasoningEffortFor`
 * saw `undefined` and `buildProviderOptions` got `byokProvider: undefined` → `{}`
 * — an env-configured Opus/Kimi/GLM got NONE of the family-default thinking a
 * connected BYOK slot of the same model would. These tests pin the fixed
 * behaviour: the env's provider+model reach the reasoning computation, so env and
 * BYOK are uniform, while `suppressReasoning` and the cloud default still hold.
 *
 * Real reasoning-options + real `envManagedReasoningDescriptor` run here; only the
 * model BUILD is stubbed (network-free) — the assertion is on `providerOptions`.
 */
jest.mock('./agent-model', () => ({
    resolveAgentModel: jest.fn(() => ({ __model: true })),
}));
jest.mock('./byok-to-vercel', () => ({
    getModelName: jest.fn(() => 'env-managed'),
}));

import { resolveModelConfig } from './model-invocation';
import { envManagedReasoningDescriptor } from './managed-slot';

const ENV_KEYS = [
    'API_LLM_PROVIDER_MODEL',
    'API_OPEN_AI_API_KEY',
    'API_OPENAI_FORCE_BASE_URL',
    'API_VERTEX_AI_API_KEY',
    'API_GOOGLE_AI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
] as const;

const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ENV_KEYS) {
        snapshot[k] = process.env[k];
        delete process.env[k];
    }
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (snapshot[k] === undefined) delete process.env[k];
        else process.env[k] = snapshot[k];
    }
});

/** Native-Anthropic env config: a `claude-*` model + an OpenAI key slot + an
 *  EMPTY force-base-url (a real endpoint would make it OpenAI-compatible). */
function envAnthropicOpus5() {
    process.env.API_LLM_PROVIDER_MODEL = 'claude-opus-5';
    process.env.API_OPEN_AI_API_KEY = 'sk-ant-test';
    process.env.API_OPENAI_FORCE_BASE_URL = '';
}

describe('envManagedReasoningDescriptor — env config → {provider, model}', () => {
    it('claude + native Anthropic key (no proxy) → anthropic', () => {
        envAnthropicOpus5();
        expect(envManagedReasoningDescriptor()).toEqual({
            provider: 'anthropic',
            model: 'claude-opus-5',
        });
    });

    it('a non-claude/gemini model with an OpenAI key → openai_compatible', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'kimi-k2.6';
        process.env.API_OPEN_AI_API_KEY = 'sk-x';
        process.env.API_OPENAI_FORCE_BASE_URL = 'https://api.moonshot.ai/v1';
        expect(envManagedReasoningDescriptor()).toEqual({
            provider: 'openai_compatible',
            model: 'kimi-k2.6',
        });
    });

    it('gemini + AI Studio key → google_gemini', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-3-pro';
        process.env.API_GOOGLE_AI_API_KEY = 'giz-test';
        expect(envManagedReasoningDescriptor()).toEqual({
            provider: 'google_gemini',
            model: 'gemini-3-pro',
        });
    });

    it('cloud (API_LLM_PROVIDER_MODEL unset/auto) → undefined', () => {
        expect(envManagedReasoningDescriptor()).toBeUndefined();
        process.env.API_LLM_PROVIDER_MODEL = 'auto';
        expect(envManagedReasoningDescriptor()).toBeUndefined();
    });
});

describe('resolveModelConfig — env reasoning reaches the funnel (uniform with BYOK)', () => {
    it('env Anthropic Opus-5 (undefined slot) → adaptive + medium, NOT {}', () => {
        envAnthropicOpus5();
        const inv = resolveModelConfig(undefined, {
            runName: 'review',
            reasoningEffortDefault: 'none', // caller default must be OVERRIDDEN
        });
        expect(inv.providerOptions).toEqual({
            anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
        });
    });

    it('matches what a CONNECTED BYOK Opus-5 slot resolves to (env == BYOK)', () => {
        envAnthropicOpus5();
        const envInv = resolveModelConfig(undefined, { runName: 'review' });
        const byokInv = resolveModelConfig(
            { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'enc' } as any,
            { runName: 'review' },
        );
        expect(envInv.providerOptions).toEqual(byokInv.providerOptions);
    });

    it('env Opus-5 still OBEYS suppressReasoning → thinking disabled', () => {
        envAnthropicOpus5();
        const inv = resolveModelConfig(undefined, {
            runName: 'kody-rules',
            suppressReasoning: true,
        });
        expect(inv.providerOptions).toEqual({
            anthropic: { thinking: { type: 'disabled' } },
        });
    });

    it('cloud (no env model, undefined slot) → caller default, no provider thinking', () => {
        const inv = resolveModelConfig(undefined, {
            runName: 'review',
            reasoningEffortDefault: 'none',
        });
        expect(inv.providerOptions).toEqual({});
    });
});
