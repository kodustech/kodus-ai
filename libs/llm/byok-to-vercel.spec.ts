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
