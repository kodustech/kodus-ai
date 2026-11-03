/**
 * A declared env provider (API_LLM_PROVIDER, #1687) is built as stated: none of
 * the inference heuristics (proxy base URL, OpenAI-reasoner endpoint, model-name
 * prefix) may override it, and a declaration that cannot run fails with its
 * reason instead of falling back to a guess or to the cloud default.
 */
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'openai-compatible',
            modelId,
            settings,
        })),
    ),
}));

import { BYOKProvider } from '@libs/llm/model-providers';
import { getClassification } from './error-classifier';
import {
    envManagedReasoningDescriptor,
    getModelName,
    hasManagedModelKey,
    resolveEnvProvider,
    resolveManagedSlot,
} from './managed-slot';

const KEYS = [
    'API_LLM_PROVIDER_MODEL',
    'API_LLM_PROVIDER',
    'API_LLM_API_KEY',
    'API_LLM_BASE_URL',
    'API_LLM_REASONING_EFFORT',
    'API_OPEN_AI_API_KEY',
    'API_OPENAI_FORCE_BASE_URL',
    'API_GOOGLE_AI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'API_VERTEX_AI_API_KEY',
    'API_VERTEX_AI_LOCATION',
    'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
});
afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

const set = (vars: Record<string, string>) => Object.assign(process.env, vars);

describe('env base URL carrying the SDK endpoint', () => {
    it('drops /chat/completions from a declared openai base URL, keeping /v1', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'gpt-5.6-luna',
            API_LLM_PROVIDER: 'openai',
            API_LLM_API_KEY: 'sk-x',
            API_LLM_BASE_URL: 'https://litellm.test/v1/chat/completions',
        });
        expect(resolveManagedSlot('unused', {})).toMatchObject({
            kind: 'slot',
            slot: { baseURL: 'https://litellm.test/v1' },
        });
    });

    it('drops /messages from a declared anthropic base URL, keeping /v1', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'claude-opus-5',
            API_LLM_PROVIDER: 'anthropic',
            API_LLM_API_KEY: 'sk-ant',
            API_LLM_BASE_URL: 'https://gateway.test/v1/messages',
        });
        expect(resolveManagedSlot('unused', {})).toMatchObject({
            kind: 'slot',
            slot: { baseURL: 'https://gateway.test/v1' },
        });
    });

    it('repairs the legacy API_OPENAI_FORCE_BASE_URL on the inferred compatible path too', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'glm-5.3',
            API_OPEN_AI_API_KEY: 'sk-x',
            API_OPENAI_FORCE_BASE_URL:
                'https://proxy.test/api/v1/chat/completions/',
        });
        const resolved = resolveManagedSlot('unused', {});
        expect(resolved.kind).toBe('inline');
        expect((resolved as any).model.settings.baseURL).toBe(
            'https://proxy.test/api/v1',
        );
    });

    it('leaves a base URL without the endpoint exactly as configured', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'glm-5.3',
            API_OPEN_AI_API_KEY: 'sk-x',
            API_OPENAI_FORCE_BASE_URL: 'https://proxy.test/api/v1/',
        });
        const resolved = resolveManagedSlot('unused', {});
        expect((resolved as any).model.settings.baseURL).toBe(
            'https://proxy.test/api/v1/',
        );
    });
});

describe('declared env provider', () => {
    it('builds openai on the native SDK behind a proxy base URL (proxy heuristic skipped)', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'gpt-5.6-luna',
            API_LLM_PROVIDER: 'openai',
            API_LLM_API_KEY: 'sk-x',
            API_LLM_BASE_URL: 'https://litellm.test/v1',
        });
        expect(resolveManagedSlot('unused', {})).toEqual({
            kind: 'slot',
            slot: {
                provider: BYOKProvider.OPENAI,
                apiKey: 'sk-x',
                model: 'gpt-5.6-luna',
                baseURL: 'https://litellm.test/v1',
            },
        });
    });

    it('keeps a declared openai_compatible on chat completions even for an OpenAI reasoner on api.openai.com', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'gpt-5.6-luna',
            API_LLM_PROVIDER: 'openai_compatible',
            API_LLM_API_KEY: 'sk-x',
        });
        expect(resolveEnvProvider()).toMatchObject({
            kind: 'openai_compat',
            baseURL: 'https://api.openai.com/v1',
            declared: true,
        });
        expect(resolveManagedSlot('unused', {}).kind).toBe('inline');
    });

    it('builds anthropic for a model whose name is not claude-*', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'my-anthropic-alias',
            API_LLM_PROVIDER: 'anthropic',
            API_LLM_API_KEY: 'sk-ant',
        });
        expect(resolveManagedSlot('unused', {})).toEqual({
            kind: 'slot',
            slot: {
                provider: BYOKProvider.ANTHROPIC,
                apiKey: 'sk-ant',
                model: 'my-anthropic-alias',
                baseURL: undefined,
            },
        });
    });

    it('builds google_gemini from the generic key, ignoring the legacy OpenAI proxy URL', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'gemini-3-pro',
            API_LLM_PROVIDER: 'google_gemini',
            API_LLM_API_KEY: 'AIza-x',
            API_OPENAI_FORCE_BASE_URL: 'https://litellm.test/v1',
        });
        expect(resolveManagedSlot('unused', {})).toEqual({
            kind: 'slot',
            slot: {
                provider: BYOKProvider.GOOGLE_GEMINI,
                apiKey: 'AIza-x',
                model: 'gemini-3-pro',
            },
        });
    });

    it('fails an invalid declaration with its reason, never the cloud default', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'some-model',
            API_LLM_PROVIDER: 'openrouter',
            API_LLM_API_KEY: 'k',
        });
        let thrown: unknown;
        try {
            resolveManagedSlot('accounts/fireworks/models/x', {});
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(getClassification(thrown)?.friendlyMessage).toBe(
            'The server LLM configuration is invalid: API_LLM_PROVIDER="openrouter" is not supported. Use one of: openai, openai_compatible, anthropic, google_gemini, google_vertex.',
        );
        // Attempted, not skipped: the reason has to reach someone.
        expect(hasManagedModelKey()).toBe(true);
        expect(envManagedReasoningDescriptor()).toBeUndefined();
        expect(getModelName()).toBe('some-model');
    });

    it('fails a generic key set without a provider instead of inferring', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'gpt-4o',
            API_LLM_API_KEY: 'sk-x',
        });
        expect(resolveEnvProvider()?.kind).toBe('invalid');
    });

    it('hands the declared reasoning effort to the reasoning computation', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'gpt-5.6-luna',
            API_LLM_PROVIDER: 'openai',
            API_LLM_API_KEY: 'sk-x',
            API_LLM_REASONING_EFFORT: 'low',
        });
        expect(envManagedReasoningDescriptor()).toEqual({
            provider: BYOKProvider.OPENAI,
            model: 'gpt-5.6-luna',
            reasoningEffort: 'low',
        });
        expect(getModelName()).toBe('openai:gpt-5.6-luna');
    });

    it('leaves an install without API_LLM_PROVIDER on the inference', () => {
        set({
            API_LLM_PROVIDER_MODEL: 'gpt-4o',
            API_OPEN_AI_API_KEY: 'sk-x',
            API_OPENAI_FORCE_BASE_URL: 'https://litellm.test/v1',
        });
        expect(resolveEnvProvider()).toEqual({
            kind: 'openai_compat',
            name: 'openai_compatible',
            apiKey: 'sk-x',
            baseURL: 'https://litellm.test/v1',
        });
    });
});
