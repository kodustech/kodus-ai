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

import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { byokToVercelModel } from './byok-to-vercel';

const createVertexMock = createVertex as unknown as jest.Mock;
const createVertexAnthropicMock = createVertexAnthropic as unknown as jest.Mock;

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

describe('byokToVercelModel — Vertex keyless (ADC) auth', () => {
    const ENV_KEYS = [
        'GOOGLE_CLOUD_PROJECT',
        'GCLOUD_PROJECT',
        'API_LLM_PROVIDER_MODEL',
        'API_VERTEX_AI_API_KEY',
        'API_VERTEX_AI_LOCATION',
        'API_OPEN_AI_API_KEY',
        'API_OPENAI_FORCE_BASE_URL',
        'API_GOOGLE_AI_API_KEY',
        'GOOGLE_GENERATIVE_AI_API_KEY',
    ] as const;
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        createVertexMock.mockClear();
        createVertexAnthropicMock.mockClear();
        saved = {};
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    function vertexConfigNoKey(model: string): BYOKConfig {
        return {
            main: {
                provider: BYOKProvider.GOOGLE_VERTEX,
                apiKey: '',
                model,
            },
        } as BYOKConfig;
    }

    it('omits googleAuthOptions so google-auth-library resolves ADC', () => {
        process.env.GOOGLE_CLOUD_PROJECT = 'adc-proj';

        byokToVercelModel(vertexConfigNoKey('claude-opus-4-6'));

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        const settings = createVertexAnthropicMock.mock.calls[0][0];
        expect(settings).toEqual({ project: 'adc-proj', location: 'global' });
        expect(settings).not.toHaveProperty('googleAuthOptions');
    });

    it('accepts GCLOUD_PROJECT as an alias for GOOGLE_CLOUD_PROJECT', () => {
        process.env.GCLOUD_PROJECT = 'alias-proj';

        byokToVercelModel(vertexConfigNoKey('gemini-2.5-pro'));

        expect(createVertexMock).toHaveBeenCalledWith(
            expect.objectContaining({ project: 'alias-proj' }),
        );
    });

    it('does not use ADC when no project is configured', () => {
        byokToVercelModel(vertexConfigNoKey('gemini-2.5-pro'));

        expect(createVertexMock).not.toHaveBeenCalled();
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
    });

    it('prefers an explicit SA key over ADC', () => {
        process.env.GOOGLE_CLOUD_PROJECT = 'adc-proj';

        byokToVercelModel(vertexConfig('gemini-2.5-pro'));

        // project comes from the SA JSON, not the env var
        expect(createVertexMock).toHaveBeenCalledWith(
            expect.objectContaining({
                project: 'my-proj',
                googleAuthOptions: expect.anything(),
            }),
        );
    });

    it('uses ADC for a claude-* model in env mode with no SA key', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-opus-4-6';
        process.env.GOOGLE_CLOUD_PROJECT = 'env-proj';
        process.env.API_VERTEX_AI_LOCATION = 'us-east5';

        const result: any = byokToVercelModel(undefined);

        expect(result.sdk).toBe('vertex-anthropic');
        expect(createVertexAnthropicMock).toHaveBeenCalledWith({
            project: 'env-proj',
            location: 'us-east5',
        });
    });

    it('lets an explicit API_OPEN_AI_API_KEY win over ambient ADC for gemini', () => {
        // GOOGLE_CLOUD_PROJECT is set by default on GCE/Cloud Run, so it must
        // not hijack a deployment that only configured an OpenAI-compatible key.
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.GOOGLE_CLOUD_PROJECT = 'ambient-proj';
        process.env.API_OPEN_AI_API_KEY = 'sk-explicit';

        byokToVercelModel(undefined);

        expect(createVertexMock).not.toHaveBeenCalled();
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
    });

    it('uses ADC for a gemini-* model in env mode with no SA key', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.GOOGLE_CLOUD_PROJECT = 'env-proj';

        const result: any = byokToVercelModel(undefined);

        expect(result.sdk).toBe('vertex-gemini');
        expect(createVertexMock).toHaveBeenCalledWith({
            project: 'env-proj',
            location: 'global',
        });
    });
});
