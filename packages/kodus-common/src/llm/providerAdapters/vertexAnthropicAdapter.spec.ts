/// <reference types="jest" />
const chatAnthropicCalls: any[] = [];
const anthropicClientCalls: any[] = [];
const chatVertexCalls: any[] = [];
const googleAuthCalls: any[] = [];

jest.mock('@langchain/anthropic', () => ({
    ChatAnthropic: jest.fn().mockImplementation((opts: any) => {
        chatAnthropicCalls.push(opts);
        return { __kind: 'ChatAnthropic', opts };
    }),
}));
jest.mock('@anthropic-ai/sdk', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation((opts: any) => {
        anthropicClientCalls.push(opts);
        return { __kind: 'Anthropic' };
    }),
}));
jest.mock('google-auth-library', () => ({
    GoogleAuth: jest.fn().mockImplementation((opts: any) => {
        googleAuthCalls.push(opts);
        return { __kind: 'GoogleAuth', getAccessToken: async () => 'tok' };
    }),
}));
jest.mock('@langchain/google-vertexai', () => ({
    ChatVertexAI: jest.fn().mockImplementation((opts: any) => {
        chatVertexCalls.push(opts);
        return { __kind: 'ChatVertexAI' };
    }),
}));

import { BYOKProvider, BYOKProviderService } from '../byokProvider.service';

const SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'my-proj',
    client_email: 'sa@my-proj.iam.gserviceaccount.com',
});

function vertexConfig(model: string, vertexLocation?: string): any {
    return {
        main: {
            provider: BYOKProvider.GOOGLE_VERTEX,
            apiKey: SA_JSON,
            model,
            vertexLocation,
        },
    };
}

describe('createBYOKProvider — Google Vertex protocol routing', () => {
    const service = new BYOKProviderService();
    const envLocation = process.env.API_VERTEX_AI_LOCATION;

    beforeEach(() => {
        chatAnthropicCalls.length = 0;
        anthropicClientCalls.length = 0;
        chatVertexCalls.length = 0;
        googleAuthCalls.length = 0;
        // Isolate from any env-mode region so the BYOK default (global) is
        // what's under test.
        delete process.env.API_VERTEX_AI_LOCATION;
    });

    afterAll(() => {
        if (envLocation !== undefined) {
            process.env.API_VERTEX_AI_LOCATION = envLocation;
        }
    });

    it('routes a claude-* Vertex model through ChatAnthropic pointed at the Vertex host', () => {
        service.createBYOKProvider(vertexConfig('claude-sonnet-4-6'));

        expect(chatAnthropicCalls).toHaveLength(1);
        expect(chatVertexCalls).toHaveLength(0);
        expect(chatAnthropicCalls[0].model).toBe('claude-sonnet-4-6');

        // Default global region → the bare aiplatform host.
        expect(chatAnthropicCalls[0].anthropicApiUrl).toBe(
            'https://aiplatform.googleapis.com/v1',
        );

        // GCP auth is wired with the cloud-platform scope and the SA creds.
        expect(googleAuthCalls[0].scopes).toContain(
            'https://www.googleapis.com/auth/cloud-platform',
        );
        expect(googleAuthCalls[0].credentials.project_id).toBe('my-proj');

        // The underlying Anthropic client is built lazily via createClient and
        // is repointed at the Vertex base URL with the custom fetch transport.
        expect(typeof chatAnthropicCalls[0].createClient).toBe('function');
        chatAnthropicCalls[0].createClient({ apiKey: 'vertex-byok' });
        expect(anthropicClientCalls[0].baseURL).toBe(
            'https://aiplatform.googleapis.com/v1',
        );
        expect(typeof anthropicClientCalls[0].fetch).toBe('function');
    });

    it('honors an explicit Vertex region for Claude', () => {
        service.createBYOKProvider(
            vertexConfig('claude-haiku-4-5@20251001', 'us-east5'),
        );
        expect(chatAnthropicCalls[0].anthropicApiUrl).toBe(
            'https://us-east5-aiplatform.googleapis.com/v1',
        );
        chatAnthropicCalls[0].createClient({ apiKey: 'vertex-byok' });
        expect(anthropicClientCalls[0].baseURL).toBe(
            'https://us-east5-aiplatform.googleapis.com/v1',
        );
    });

    it('routes a gemini-* Vertex model through ChatVertexAI (not Anthropic)', () => {
        service.createBYOKProvider(vertexConfig('gemini-2.5-pro'));

        expect(chatVertexCalls).toHaveLength(1);
        expect(chatAnthropicCalls).toHaveLength(0);
        expect(anthropicClientCalls).toHaveLength(0);
    });
});
