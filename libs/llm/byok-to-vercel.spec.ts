import { BYOKConfig, BYOKProvider } from '@kodus/kodus-common/llm';

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

import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { byokToVercelModel } from './byok-to-vercel';

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

function vertexConfig(model: string, vertexLocation?: string): BYOKConfig {
    return {
        main: {
            provider: BYOKProvider.GOOGLE_VERTEX,
            apiKey: SA_JSON_B64,
            model,
            vertexLocation,
        },
    } as BYOKConfig;
}

describe('byokToVercelModel — Google Vertex protocol routing', () => {
    beforeEach(() => {
        createVertexMock.mockClear();
        createVertexAnthropicMock.mockClear();
    });

    it('routes a claude-* model id through createVertexAnthropic (Anthropic protocol)', () => {
        const result: any = byokToVercelModel(
            vertexConfig('claude-3-5-sonnet-v2@20241022', 'us-east5'),
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
        const rawJsonConfig = {
            main: {
                provider: BYOKProvider.GOOGLE_VERTEX,
                apiKey: JSON.stringify({
                    type: 'service_account',
                    project_id: 'my-proj',
                    client_email: 'sa@my-proj.iam.gserviceaccount.com',
                }),
                model: 'claude-opus-4-8',
                vertexLocation: 'global',
            },
        } as BYOKConfig;

        const result: any = byokToVercelModel(rawJsonConfig);

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(result.modelId).toBe('claude-opus-4-8');
        expect(createVertexAnthropicMock).toHaveBeenCalledWith(
            expect.objectContaining({ project: 'my-proj', location: 'global' }),
        );
    });

    it('routes a gemini-* model id through createVertex (Gemini protocol)', () => {
        const result: any = byokToVercelModel(vertexConfig('gemini-2.5-pro'));

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

// Phase 1 tracer: OPENAI + OPENAI_COMPATIBLE now resolve through the provider
// REGISTRY (libs/llm/providers/openai.module). These assert the registry-routed
// build reproduces the OLD inline construction exactly (same factory, same args,
// same json_schema gate) — the no-regression guarantee for the ported provider.
describe('byokToVercelModel — OpenAI registry routing (Phase 1 tracer)', () => {
    beforeEach(() => {
        createOpenAIMock.mockClear();
        createOpenAICompatibleMock.mockClear();
    });

    it('routes provider "openai" through createOpenAI with the decrypted key and no baseURL', () => {
        const result: any = byokToVercelModel({
            main: {
                provider: BYOKProvider.OPENAI,
                apiKey: 'sk-plain',
                model: 'gpt-4o',
            },
        } as BYOKConfig);

        expect(createOpenAIMock).toHaveBeenCalledTimes(1);
        expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('openai');
        expect(result.modelId).toBe('gpt-4o');
        expect(createOpenAIMock).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'sk-plain' }),
        );
        // No baseURL key when the config omits it (native SDK default).
        expect(createOpenAIMock.mock.calls[0][0]).not.toHaveProperty('baseURL');
    });

    it('routes "openai_compatible" through createOpenAICompatible; the :8000 gate enables structured outputs when opted in', () => {
        const result: any = byokToVercelModel(
            {
                main: {
                    provider: BYOKProvider.OPENAI_COMPATIBLE,
                    apiKey: 'sk-compat',
                    model: 'kimi-k2.7-code',
                    baseURL: 'https://host:8000/v1',
                },
            } as BYOKConfig,
            'main',
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
        byokToVercelModel({
            main: {
                provider: BYOKProvider.OPENAI_COMPATIBLE,
                apiKey: 'sk-compat',
                model: 'kimi-k2.7-code',
                baseURL: 'https://host:8000/v1',
            },
        } as BYOKConfig);

        expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
            expect.objectContaining({ supportsStructuredOutputs: false }),
        );
    });
});
