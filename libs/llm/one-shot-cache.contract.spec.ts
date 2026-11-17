/**
 * The marker a one-shot call carries must survive each provider's real
 * serializer: a marker an adapter does not read is dropped without a warning,
 * which is how Claude on Bedrock ran with zero cache reads. Offline: fetch is
 * intercepted, no provider is called.
 */
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type LanguageModel } from 'ai';
import { applyOneShotCache, resolvePrefixCacheHint } from './one-shot-cache';

const SYSTEM = 'You check team rules against one file.';
const HEAD = '<Rules>\n[1] no console.log\n</Rules>\n';
const TAIL = '<File path="a.ts">\n+console.log(1)\n</File>';

type Captured = { body: any };

function stubFetch(captured: Captured, response: unknown): typeof fetch {
    return (async (_url: unknown, init?: { body?: unknown }) => {
        captured.body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof fetch;
}

async function send(
    model: LanguageModel,
    provider: string,
    modelId: string,
    cache: { userPrefix?: string; system?: boolean },
) {
    const { args, providerOptions } = applyOneShotCache({
        system: SYSTEM,
        prompt: HEAD + TAIL,
        cache,
        hint: resolvePrefixCacheHint({ provider, model: modelId }),
    });
    await generateText({
        model,
        ...(args as any),
        ...(providerOptions ? { providerOptions } : {}),
    });
}

describe('Claude on Bedrock: the shared head gets a Converse cachePoint', () => {
    const MODEL = 'eu.anthropic.claude-sonnet-5-5';
    const converseOk = {
        output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const bedrock = (captured: Captured) =>
        createAmazonBedrock({
            region: 'eu-central-1',
            apiKey: 'test-key',
            fetch: stubFetch(captured, converseOk),
        });

    it('puts the cachePoint right after the head, before the unique tail', async () => {
        const captured: Captured = { body: undefined };
        await send(bedrock(captured)(MODEL), 'amazon_bedrock', MODEL, {
            userPrefix: HEAD,
        });
        const user = captured.body.messages.find((m: any) => m.role === 'user');
        expect(user.content).toEqual([
            { text: HEAD },
            { cachePoint: { type: 'default' } },
            { text: TAIL },
        ]);
    });

    it('marks the system prompt when it is the shared part', async () => {
        const captured: Captured = { body: undefined };
        await send(bedrock(captured)(MODEL), 'amazon_bedrock', MODEL, {
            system: true,
        });
        expect(captured.body.system).toEqual([
            { text: SYSTEM },
            { cachePoint: { type: 'default' } },
        ]);
    });
});

describe('native Claude: the shared head gets cache_control', () => {
    const MODEL = 'claude-sonnet-5-5';
    const messagesOk = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
    };

    it('marks the head block and leaves the tail block and the request unmarked', async () => {
        const captured: Captured = { body: undefined };
        const anthropic = createAnthropic({
            apiKey: 'test-key',
            fetch: stubFetch(captured, messagesOk),
        });
        await send(anthropic(MODEL), 'anthropic', MODEL, { userPrefix: HEAD });
        const user = captured.body.messages.find((m: any) => m.role === 'user');
        expect(user.content).toEqual([
            { type: 'text', text: HEAD, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: TAIL },
        ]);
        expect(captured.body.cache_control).toBeUndefined();
    });
});

describe('OpenAI gpt-5.6+: the shared head gets an explicit breakpoint', () => {
    const responsesOk = {
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'gpt-6.1-sol',
        output: [
            {
                type: 'message',
                id: 'msg_1',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };

    it.each(['gpt-5.6', 'gpt-6.1-sol'])(
        'marks the head input_text and puts the request in explicit mode on %s',
        async (modelId) => {
            const captured: Captured = { body: undefined };
            const openai = createOpenAI({
                apiKey: 'test-key',
                fetch: stubFetch(captured, { ...responsesOk, model: modelId }),
            });
            await send(openai(modelId), 'openai', modelId, {
                userPrefix: HEAD,
            });
            const user = captured.body.input.find(
                (m: any) => m.role === 'user',
            );
            expect(user.content).toEqual([
                {
                    type: 'input_text',
                    text: HEAD,
                    prompt_cache_breakpoint: { mode: 'explicit' },
                },
                { type: 'input_text', text: TAIL },
            ]);
            expect(captured.body.prompt_cache_options).toEqual({
                mode: 'explicit',
            });
        },
    );

    it('marks the system prompt when it is the shared part, so explicit mode still has a breakpoint', async () => {
        const captured: Captured = { body: undefined };
        const openai = createOpenAI({
            apiKey: 'test-key',
            fetch: stubFetch(captured, responsesOk),
        });
        await send(openai('gpt-6.1-sol'), 'openai', 'gpt-6.1-sol', {
            system: true,
        });
        const system = captured.body.input.find(
            (m: any) => m.role === 'system' || m.role === 'developer',
        );
        expect(system.content).toEqual([
            {
                type: 'input_text',
                text: SYSTEM,
                prompt_cache_breakpoint: { mode: 'explicit' },
            },
        ]);
        expect(captured.body.prompt_cache_options).toEqual({
            mode: 'explicit',
        });
    });

    it('sends a model before 5.6 exactly as before', async () => {
        const captured: Captured = { body: undefined };
        const openai = createOpenAI({
            apiKey: 'test-key',
            fetch: stubFetch(captured, { ...responsesOk, model: 'gpt-5.5' }),
        });
        await send(openai('gpt-5.5'), 'openai', 'gpt-5.5', {
            userPrefix: HEAD,
        });
        const user = captured.body.input.find((m: any) => m.role === 'user');
        expect(JSON.stringify(user)).not.toContain('prompt_cache_breakpoint');
        expect(captured.body.prompt_cache_options).toBeUndefined();
    });
});
