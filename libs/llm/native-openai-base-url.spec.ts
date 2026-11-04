jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { tool } from 'ai';
import { z } from 'zod';

import { LLM } from './llm';
import { resolveTaskSlot } from './resolve-task-model';
import { probeSlotCall } from './probe-slot-call';
import './providers';

/**
 * A native OpenAI credential pointed at the org's own OpenAI-protocol proxy
 * (#2150) runs on the same transport as a direct key: the Responses API on the
 * proxy, the configured effort, a strict JSON schema, and nothing stored.
 */
const PROXY = 'https://llm-proxy.example.com/v1';

function recordUpstream() {
    const calls: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
        calls.push({
            url: String(input?.url ?? input),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        // 400 so the SDK does not retry: the request is what is asserted.
        return new Response(JSON.stringify({ error: { message: 'stop' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = realFetch) };
}

const proxiedSlot = (baseURL?: string) =>
    resolveTaskSlot(
        {
            version: 2,
            credentials: [
                {
                    id: 'c-openai',
                    provider: 'openai',
                    apiKey: 'k',
                    settings: baseURL ? { baseURL } : {},
                },
            ],
            models: [
                {
                    id: 'm-1',
                    credentialId: 'c-openai',
                    model: 'gpt-5.4',
                    reasoningEffort: 'high',
                },
            ],
            routing: { defaultModelId: 'm-1' },
        } as any,
        'codeReview',
    ).slot;

const base = {
    organizationId: 'org-1',
    messages: [{ role: 'user', content: 'ping' }],
    runName: 'native-openai-base-url-spec',
};

describe('native OpenAI credential with a custom base URL', () => {
    let up: ReturnType<typeof recordUpstream>;
    beforeEach(() => {
        up = recordUpstream();
    });
    afterEach(() => up.restore());

    it('runs an agent loop on <base URL>/responses with the effort and nothing stored', async () => {
        await LLM.run({
            ...base,
            byokConfig: { ...proxiedSlot(PROXY), apiKey: 'k' },
            loop: {
                tools: {
                    ping: tool({
                        description: 'ping',
                        inputSchema: z.object({}),
                        execute: async () => 'pong',
                    }),
                },
                maxSteps: 1,
            },
        } as any).catch(() => undefined);

        expect(up.calls[0].url).toBe(`${PROXY}/responses`);
        expect(up.calls[0].body.reasoning?.effort).toBe('high');
        expect(up.calls[0].body.tools).toHaveLength(1);
        // A pooled proxy cannot resolve an item stored on another account, and
        // a forwarding proxy would otherwise have OpenAI keep the PR's code.
        expect(up.calls[0].body.store).toBe(false);
        expect(up.calls[0].body.include).toContain(
            'reasoning.encrypted_content',
        );
    });

    it('sends structured output as a strict JSON schema', async () => {
        await LLM.run({
            ...base,
            byokConfig: { ...proxiedSlot(PROXY), apiKey: 'k' },
            user: 'ping',
            schema: z.object({ answer: z.string() }),
        } as any).catch(() => undefined);

        const format = up.calls[0].body.text?.format;
        expect(up.calls[0].url).toBe(`${PROXY}/responses`);
        expect(format?.type).toBe('json_schema');
        expect(format?.strict).toBe(true);
    });

    it('probes the same endpoint when the connection is tested', async () => {
        await probeSlotCall({
            provider: 'openai',
            model: 'gpt-5.4',
            baseURL: PROXY,
            apiKey: 'k',
        } as any).catch(() => undefined);

        expect(up.calls[0].url).toBe(`${PROXY}/responses`);
    });

    it('without a base URL still calls api.openai.com', async () => {
        await LLM.run({
            ...base,
            byokConfig: { ...proxiedSlot(), apiKey: 'k' },
            user: 'ping',
        } as any).catch(() => undefined);

        expect(up.calls[0].url).toBe('https://api.openai.com/v1/responses');
        expect(up.calls[0].body.store).toBe(false);
    });
});
