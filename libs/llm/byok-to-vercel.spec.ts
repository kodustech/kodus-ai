import { BYOKProvider } from '@kodus/kodus-common/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';

// Capture which Vertex SDK factory each model id routes to. Mock factories
// are hoisted above module-scope consts, so define the jest.fn inside the
// factory and pull the references out via the mocked imports below. The
// inner factory (the value createVertex/createVertexAnthropic returns) is
// what's actually invoked with the model id, so we tag its return value.
jest.mock('@ai-sdk/google-vertex', () => ({
    createVertex: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'vertex-gemini',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/google-vertex/anthropic', () => ({
    createVertexAnthropic: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'vertex-anthropic',
            modelId,
            settings,
        })),
    ),
}));
// decrypt is identity in tests: the apiKey we pass IS the base64 SA JSON.
jest.mock('@libs/common/utils/crypto', () => ({ decrypt: (v: string) => v }));
// Tag the OpenAI SDK factories so we can assert the registry-routed openai /
// openai_compatible cases reproduce the old inline construction (Phase 1 tracer).
jest.mock('@ai-sdk/openai', () => ({
    createOpenAI: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({ sdk: 'openai', modelId, settings })),
    ),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'openai-compatible',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/google', () => ({
    createGoogleGenerativeAI: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({ sdk: 'google', modelId, settings })),
    ),
}));

import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { buildModelFromSlot, getModelName } from './byok-to-vercel';

const createVertexMock = createVertex as unknown as jest.Mock;
const createVertexAnthropicMock = createVertexAnthropic as unknown as jest.Mock;
const createOpenAIMock = createOpenAI as unknown as jest.Mock;
const createOpenAICompatibleMock = createOpenAICompatible as unknown as jest.Mock;

const SA_JSON_B64 = Buffer.from(
    JSON.stringify({
        type: 'service_account',
        project_id: 'my-proj',
        client_email: 'sa@my-proj.iam.gserviceaccount.com',
    }),
).toString('base64');

// v2-native: buildModelFromSlot takes ONE resolved slot (NormalizedModel), never
// a legacy `{main,fallback}` carrier. These helpers build a plain slot.
function vertexSlot(model: string, vertexLocation?: string): NormalizedModel {
    return {
        provider: BYOKProvider.GOOGLE_VERTEX,
        apiKey: SA_JSON_B64,
        model,
        vertexLocation,
    } as NormalizedModel;
}

describe('buildModelFromSlot — Google Vertex protocol routing (resolved slot)', () => {
    beforeEach(() => {
        createVertexMock.mockClear();
        createVertexAnthropicMock.mockClear();
    });

    it('routes a claude-* model id through createVertexAnthropic (Anthropic protocol)', () => {
        const result: any = buildModelFromSlot(
            vertexSlot('claude-3-5-sonnet-v2@20241022', 'us-east5'),
        );

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('vertex-anthropic');
        expect(result.modelId).toBe('claude-3-5-sonnet-v2@20241022');
        // SA project + region flow through to the provider settings.
        expect(createVertexAnthropicMock).toHaveBeenCalledWith(
            expect.objectContaining({ project: 'my-proj', location: 'us-east5' }),
        );
    });

    it('accepts a raw (non-base64) SA JSON and still routes claude-* to Vertex Anthropic', () => {
        const rawJsonSlot = {
            provider: BYOKProvider.GOOGLE_VERTEX,
            apiKey: JSON.stringify({
                type: 'service_account',
                project_id: 'my-proj',
                client_email: 'sa@my-proj.iam.gserviceaccount.com',
            }),
            model: 'claude-opus-4-8',
            vertexLocation: 'global',
        } as NormalizedModel;

        const result: any = buildModelFromSlot(rawJsonSlot);

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(result.modelId).toBe('claude-opus-4-8');
        expect(createVertexAnthropicMock).toHaveBeenCalledWith(
            expect.objectContaining({ project: 'my-proj', location: 'global' }),
        );
    });

    it('routes a gemini-* model id through createVertex (Gemini protocol)', () => {
        const result: any = buildModelFromSlot(vertexSlot('gemini-2.5-pro'));

        expect(createVertexMock).toHaveBeenCalledTimes(1);
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('vertex-gemini');
        expect(result.modelId).toBe('gemini-2.5-pro');
        // No vertexLocation → defaults to the global endpoint.
        expect(createVertexMock).toHaveBeenCalledWith(
            expect.objectContaining({
                project: 'my-proj',
                location: 'global',
            }),
        );
    });
});

// Phase 1 tracer: OPENAI + OPENAI_COMPATIBLE resolve through the provider
// REGISTRY (libs/llm/providers/openai.module). These assert the registry-routed
// build reproduces the OLD inline construction exactly (same factory, same args,
// same json_schema gate) — the no-regression guarantee for the ported provider.
describe('buildModelFromSlot — OpenAI registry routing (resolved slot)', () => {
    beforeEach(() => {
        createOpenAIMock.mockClear();
        createOpenAICompatibleMock.mockClear();
    });

    it('routes provider "openai" through createOpenAI with the decrypted key and no baseURL', () => {
        const result: any = buildModelFromSlot({
            provider: BYOKProvider.OPENAI,
            apiKey: 'sk-plain',
            model: 'gpt-4o',
        } as NormalizedModel);

        expect(createOpenAIMock).toHaveBeenCalledTimes(1);
        expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('openai');
        expect(result.modelId).toBe('gpt-4o');
        expect(createOpenAIMock).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'sk-plain' }),
        );
        // No baseURL key when the slot omits it (native SDK default).
        expect(createOpenAIMock.mock.calls[0][0]).not.toHaveProperty('baseURL');
    });

    it('routes "openai_compatible" through createOpenAICompatible; the :8000 gate enables structured outputs when opted in', () => {
        const result: any = buildModelFromSlot(
            {
                provider: BYOKProvider.OPENAI_COMPATIBLE,
                apiKey: 'sk-compat',
                model: 'kimi-k2.7-code',
                baseURL: 'https://host:8000/v1',
            } as NormalizedModel,
            { structuredOutputs: true },
        );

        expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
        expect(result.sdk).toBe('openai-compatible');
        expect(result.modelId).toBe('kimi-k2.7-code');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'openai-compatible',
                apiKey: 'sk-compat',
                baseURL: 'https://host:8000/v1',
                supportsStructuredOutputs: true,
            }),
        );
    });

    it('openai_compatible: structured outputs stay OFF without the per-call opt-in, even on a :8000 base', () => {
        buildModelFromSlot({
            provider: BYOKProvider.OPENAI_COMPATIBLE,
            apiKey: 'sk-compat',
            model: 'kimi-k2.7-code',
            baseURL: 'https://host:8000/v1',
        } as NormalizedModel);

        expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
            expect.objectContaining({ supportsStructuredOutputs: false }),
        );
    });
});

// v2-native env/managed default path: a `undefined` slot is the no-BYOK path
// (managed org / self-host env), NOT a `.main`/`.fallback` read.
describe('buildModelFromSlot — env/managed default (undefined slot)', () => {
    const prevEnvMode = process.env.API_LLM_PROVIDER_MODEL;
    const prevMoonshot = process.env.API_MOONSHOT_API_KEY;

    beforeEach(() => {
        createOpenAICompatibleMock.mockClear();
        delete process.env.API_LLM_PROVIDER_MODEL;
        process.env.API_MOONSHOT_API_KEY = 'ms-key';
    });

    afterAll(() => {
        if (prevEnvMode === undefined) delete process.env.API_LLM_PROVIDER_MODEL;
        else process.env.API_LLM_PROVIDER_MODEL = prevEnvMode;
        if (prevMoonshot === undefined) delete process.env.API_MOONSHOT_API_KEY;
        else process.env.API_MOONSHOT_API_KEY = prevMoonshot;
    });

    it('no slot + auto env → the managed Kimi default (kimi-k2.7-code via Moonshot)', () => {
        const result: any = buildModelFromSlot(undefined);

        expect(result.modelId).toBe('kimi-k2.7-code');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'moonshot' }),
        );
    });

    it('no slot + defaultModelOverride → the overridden default model id', () => {
        const result: any = buildModelFromSlot(undefined, {}, 'kimi-k2.7-code');
        expect(result.modelId).toBe('kimi-k2.7-code');
    });
});

describe('getModelName — resolved slot vs env default', () => {
    const prevEnvMode = process.env.API_LLM_PROVIDER_MODEL;

    beforeEach(() => {
        delete process.env.API_LLM_PROVIDER_MODEL;
    });

    afterAll(() => {
        if (prevEnvMode === undefined) delete process.env.API_LLM_PROVIDER_MODEL;
        else process.env.API_LLM_PROVIDER_MODEL = prevEnvMode;
    });

    it('derives `${provider}:${model}` from a single resolved slot', () => {
        expect(
            getModelName({
                provider: BYOKProvider.OPENAI,
                apiKey: 'sk-x',
                model: 'gpt-4o',
            } as NormalizedModel),
        ).toBe('openai:gpt-4o');
    });

    it('undefined slot + auto env → the managed default model id', () => {
        expect(getModelName(undefined)).toBe('kimi-k2.7-code');
    });

    it('undefined slot preserves the self-host env-mode name branch', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.API_VERTEX_AI_API_KEY = 'sa';
        try {
            expect(getModelName(undefined)).toBe('google_vertex:gemini-2.5-pro');
        } finally {
            delete process.env.API_VERTEX_AI_API_KEY;
        }
    });

    it('undefined slot + defaultModelOverride → the overridden name', () => {
        expect(getModelName(undefined, 'gemini-2.5-flash')).toBe(
            'gemini-2.5-flash',
        );
    });
});

describe('buildModelFromSlot — secret hygiene (no plaintext key logged)', () => {
    it('never writes the decrypted key to any console sink', () => {
        const sinks = ['log', 'warn', 'error', 'info', 'debug'] as const;
        const spies = sinks.map((s) =>
            jest.spyOn(console, s).mockImplementation(() => undefined),
        );
        try {
            buildModelFromSlot({
                provider: BYOKProvider.OPENAI,
                apiKey: 'sk-super-secret',
                model: 'gpt-4o',
            } as NormalizedModel);

            for (const spy of spies) {
                for (const call of spy.mock.calls) {
                    expect(JSON.stringify(call)).not.toContain('sk-super-secret');
                }
            }
        } finally {
            spies.forEach((s) => s.mockRestore());
        }
    });
});
