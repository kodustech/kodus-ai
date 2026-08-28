import { generateText } from 'ai';
import {
    buildCodexSubscriptionModel,
    setCodexCredentialStore,
    withGenerateFromStream,
} from './codex-subscription-model';

type StreamModel = Parameters<typeof withGenerateFromStream>[0];
type StreamPart =
    Awaited<
        ReturnType<StreamModel['doStream']>
    >['stream'] extends ReadableStream<infer Part>
        ? Part
        : never;

const usage = {
    inputTokens: {
        total: 4,
        noCache: 4,
        cacheRead: 0,
        cacheWrite: 0,
    },
    outputTokens: { total: 3, text: 2, reasoning: 1 },
};

function streamModel(parts: StreamPart[]): StreamModel {
    return {
        specificationVersion: 'v4',
        provider: 'openai.responses',
        modelId: 'gpt-5.6-luna',
        supportedUrls: {},
        doGenerate: async () => {
            throw new Error('not used');
        },
        doStream: async () => ({
            stream: new ReadableStream<StreamPart>({
                start(controller) {
                    for (const part of parts) controller.enqueue(part);
                    controller.close();
                },
            }),
        }),
    };
}

function promptOptions(): Parameters<StreamModel['doStream']>[0] {
    return {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };
}

describe('Codex subscription transport', () => {
    it('reassembles fragments in stream order and carries retained reasoning metadata', async () => {
        const model = withGenerateFromStream(
            streamModel([
                {
                    type: 'reasoning-start',
                    id: 'r1',
                    providerMetadata: {
                        openai: {
                            itemId: 'reasoning-item',
                            reasoningEncryptedContent: 'encrypted-reasoning',
                        },
                    },
                },
                { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
                {
                    type: 'reasoning-end',
                    id: 'r1',
                    providerMetadata: {
                        openai: {
                            reasoningEncryptedContent: 'encrypted-reasoning',
                        },
                    },
                },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'first' },
                { type: 'text-start', id: 't2' },
                { type: 'text-delta', id: 't2', delta: 'second' },
                {
                    type: 'response-metadata',
                    id: 'response-id',
                    modelId: 'gpt-5.6-luna',
                },
                {
                    type: 'finish',
                    usage,
                    finishReason: { unified: 'stop', raw: 'completed' },
                },
            ]),
        );

        if (typeof model === 'string' || model.specificationVersion !== 'v4') {
            throw new Error('Expected a v4 language model');
        }
        const result = await model.doGenerate(promptOptions());

        expect(result.content).toEqual([
            {
                type: 'reasoning',
                text: 'thinking',
                providerMetadata: {
                    openai: {
                        itemId: 'reasoning-item',
                        reasoningEncryptedContent: 'encrypted-reasoning',
                    },
                },
            },
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
        ]);
        expect(result.response).toEqual({
            id: 'response-id',
            modelId: 'gpt-5.6-luna',
        });
        expect(result.response).not.toHaveProperty('type');
    });

    it('round-trips encrypted_content into the second request body', async () => {
        const requests: Array<Record<string, unknown>> = [];
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async (_input, init) => {
            requests.push(
                JSON.parse(String(init?.body)) as Record<string, unknown>,
            );
            const events = [
                {
                    type: 'response.created',
                    response: {
                        id: 'response-1',
                        created_at: 1,
                        model: 'gpt-5.6-luna',
                    },
                },
                {
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: {
                        type: 'reasoning',
                        id: 'reasoning-1',
                        encrypted_content: 'encrypted-content-1',
                    },
                },
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                        type: 'reasoning',
                        id: 'reasoning-1',
                        encrypted_content: 'encrypted-content-1',
                    },
                },
                {
                    type: 'response.output_item.added',
                    output_index: 1,
                    item: { type: 'message', id: 'message-1' },
                },
                {
                    type: 'response.output_text.delta',
                    item_id: 'message-1',
                    output_index: 1,
                    delta: 'answer',
                },
                {
                    type: 'response.output_item.done',
                    output_index: 1,
                    item: { type: 'message', id: 'message-1' },
                },
                {
                    type: 'response.completed',
                    response: {
                        usage: {
                            input_tokens: 4,
                            output_tokens: 3,
                            output_tokens_details: { reasoning_tokens: 1 },
                        },
                    },
                },
            ];
            return new Response(
                events
                    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                    .join(''),
                {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                },
            );
        }) as typeof fetch;

        try {
            const model = buildCodexSubscriptionModel('gpt-5.6-luna', {
                accessToken: 'access-token',
                refreshToken: 'refresh-token',
                accountId: 'account-id',
            });
            const first = await generateText({ model, prompt: 'first step' });
            await generateText({
                model,
                messages: [
                    { role: 'user', content: 'first step' },
                    ...first.response.messages,
                    { role: 'user', content: 'second step' },
                ],
            });

            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[1])).toContain(
                'encrypted-content-1',
            );
            expect(requests[0]).toMatchObject({
                stream: true,
                store: false,
                include: ['reasoning.encrypted_content'],
            });
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('removes unsupported settings and honors the retained-reasoning opt-out', async () => {
        const requests: Array<Record<string, unknown>> = [];
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async (_input, init) => {
            requests.push(
                JSON.parse(String(init?.body)) as Record<string, unknown>,
            );
            return new Response(
                `data: ${JSON.stringify({
                    type: 'response.completed',
                    response: {
                        usage: { input_tokens: 1, output_tokens: 1 },
                    },
                })}\n\n`,
                {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                },
            );
        }) as typeof fetch;

        try {
            const model = buildCodexSubscriptionModel(
                'gpt-5.6-luna',
                {
                    accessToken: 'access-token',
                    accountId: 'account-id',
                },
                { retainReasoning: false },
            );
            await generateText({
                model,
                prompt: 'test',
                temperature: 0.7,
                maxOutputTokens: 100,
            });
            expect(requests[0]).not.toHaveProperty('temperature');
            expect(requests[0]).not.toHaveProperty('max_output_tokens');
            expect(requests[0]).not.toHaveProperty('include');
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('persists a rotated refresh token before retrying with the new access token', async () => {
        const order: string[] = [];
        const originalFetch = global.fetch;
        let codexCalls = 0;
        global.fetch = jest.fn(async (input) => {
            const url = String(input);
            if (url.includes('/oauth/token')) {
                order.push('refresh');
                return Response.json({
                    access_token: 'new-access',
                    refresh_token: 'new-refresh',
                });
            }
            codexCalls++;
            order.push(`codex-${codexCalls}`);
            if (codexCalls === 1) {
                return new Response('expired', { status: 401 });
            }
            return new Response(
                `data: ${JSON.stringify({
                    type: 'response.completed',
                    response: {
                        usage: { input_tokens: 1, output_tokens: 1 },
                    },
                })}\n\n`,
                {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                },
            );
        }) as typeof fetch;
        setCodexCredentialStore({
            rotateCodexTokens: async (input) => {
                order.push('persist');
                expect(input).toMatchObject({
                    credentialId: 'credential-id',
                    expectedRefreshToken: 'old-refresh',
                    accessToken: 'new-access',
                    refreshToken: 'new-refresh',
                });
                return {
                    accessToken: input.accessToken,
                    refreshToken: input.refreshToken,
                    accountId: input.accountId,
                };
            },
        });

        try {
            const model = buildCodexSubscriptionModel('gpt-5.6-luna', {
                accessToken: 'old-access',
                refreshToken: 'old-refresh',
                accountId: 'account-id',
                credentialId: 'credential-id',
            });
            await generateText({ model, prompt: 'retry' });
            expect(order).toEqual(['codex-1', 'refresh', 'persist', 'codex-2']);
        } finally {
            setCodexCredentialStore(undefined);
            global.fetch = originalFetch;
        }
    });

    it('does not use a refreshed access token when persistence fails', async () => {
        const originalFetch = global.fetch;
        let codexCalls = 0;
        global.fetch = jest.fn(async (input) => {
            if (String(input).includes('/oauth/token')) {
                return Response.json({
                    access_token: 'new-access',
                    refresh_token: 'new-refresh',
                });
            }
            codexCalls++;
            return new Response('expired', { status: 401 });
        }) as typeof fetch;
        setCodexCredentialStore({
            rotateCodexTokens: async () => {
                throw new Error('database unavailable');
            },
        });

        try {
            const model = buildCodexSubscriptionModel('gpt-5.6-luna', {
                accessToken: 'old-access',
                refreshToken: 'old-refresh',
                accountId: 'account-id',
                credentialId: 'credential-id',
            });
            await expect(
                generateText({ model, prompt: 'retry' }),
            ).rejects.toThrow('database unavailable');
            expect(codexCalls).toBe(1);
        } finally {
            setCodexCredentialStore(undefined);
            global.fetch = originalFetch;
        }
    });

    it('does not read the auth file while constructing the model', () => {
        const previous = process.env.API_CODEX_AUTH_FILE;
        delete process.env.API_CODEX_AUTH_FILE;
        try {
            expect(() =>
                buildCodexSubscriptionModel('gpt-5.6-luna'),
            ).not.toThrow();
        } finally {
            if (previous === undefined) delete process.env.API_CODEX_AUTH_FILE;
            else process.env.API_CODEX_AUTH_FILE = previous;
        }
    });
});
