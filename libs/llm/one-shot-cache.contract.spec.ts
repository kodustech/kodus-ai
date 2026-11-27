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
import { readAiSdkUsage } from './ai-sdk-usage';
import { applyOneShotCache, resolvePrefixCacheHint } from './one-shot-cache';

const SYSTEM = 'You check team rules against one file.';
const RULES = '<Rules>\n[1] no console.log\n</Rules>\n';
const INTENT = '<PR title="Add logging">\n</PR>\n';
const HEAD = RULES + INTENT;
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
    cache: { userPrefixes?: string[]; system?: boolean } | undefined,
    slotOptions?: Record<string, unknown>,
) {
    const { args, providerOptions } = applyOneShotCache({
        system: SYSTEM,
        prompt: HEAD + TAIL,
        cache,
        hint: resolvePrefixCacheHint({ provider, model: modelId }),
        providerOptions: slotOptions,
    });
    return generateText({
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
            userPrefixes: [HEAD],
        });
        const user = captured.body.messages.find((m: any) => m.role === 'user');
        expect(user.content).toEqual([
            { text: HEAD },
            { cachePoint: { type: 'default' } },
            { text: TAIL },
        ]);
    });

    it('puts a cachePoint after the rules and another after the head', async () => {
        const captured: Captured = { body: undefined };
        await send(bedrock(captured)(MODEL), 'amazon_bedrock', MODEL, {
            userPrefixes: [RULES, HEAD],
        });
        const user = captured.body.messages.find((m: any) => m.role === 'user');
        expect(user.content).toEqual([
            { text: RULES },
            { cachePoint: { type: 'default' } },
            { text: INTENT },
            { cachePoint: { type: 'default' } },
            { text: TAIL },
        ]);
    });

    it('bills a two-breakpoint call from the counts Bedrock reports, each token once', async () => {
        const captured: Captured = { body: undefined };
        const withCache = createAmazonBedrock({
            region: 'eu-central-1',
            apiKey: 'test-key',
            fetch: stubFetch(captured, {
                ...converseOk,
                usage: {
                    inputTokens: 40,
                    outputTokens: 5,
                    totalTokens: 1645,
                    cacheReadInputTokens: 1200,
                    cacheWriteInputTokens: 400,
                },
            }),
        });
        const result = await send(withCache(MODEL), 'amazon_bedrock', MODEL, {
            userPrefixes: [RULES, HEAD],
        });
        expect(readAiSdkUsage(result.usage)).toMatchObject({
            inputTokens: 1640,
            cacheReadTokens: 1200,
            cacheWriteTokens: 400,
        });
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
        await send(anthropic(MODEL), 'anthropic', MODEL, {
            userPrefixes: [HEAD],
        });
        const user = captured.body.messages.find((m: any) => m.role === 'user');
        expect(user.content).toEqual([
            { type: 'text', text: HEAD, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: TAIL },
        ]);
        expect(captured.body.cache_control).toBeUndefined();
    });

    it('marks the rules block and the head block', async () => {
        const captured: Captured = { body: undefined };
        const anthropic = createAnthropic({
            apiKey: 'test-key',
            fetch: stubFetch(captured, messagesOk),
        });
        await send(anthropic(MODEL), 'anthropic', MODEL, {
            userPrefixes: [RULES, HEAD],
        });
        const user = captured.body.messages.find((m: any) => m.role === 'user');
        expect(user.content).toEqual([
            { type: 'text', text: RULES, cache_control: { type: 'ephemeral' } },
            {
                type: 'text',
                text: INTENT,
                cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: TAIL },
        ]);
    });

    it('bills a two-breakpoint call from the counts Anthropic reports, each token once', async () => {
        const captured: Captured = { body: undefined };
        const anthropic = createAnthropic({
            apiKey: 'test-key',
            fetch: stubFetch(captured, {
                ...messagesOk,
                usage: {
                    input_tokens: 40,
                    output_tokens: 5,
                    cache_read_input_tokens: 1200,
                    cache_creation_input_tokens: 400,
                },
            }),
        });
        const result = await send(anthropic(MODEL), 'anthropic', MODEL, {
            userPrefixes: [RULES, HEAD],
        });
        expect(readAiSdkUsage(result.usage)).toMatchObject({
            inputTokens: 1640,
            cacheReadTokens: 1200,
            cacheWriteTokens: 400,
        });
    });

    it('sends no cache_control at all on a declared call with nothing to mark, whatever the slot asks for', async () => {
        const captured: Captured = { body: undefined };
        const anthropic = createAnthropic({
            apiKey: 'test-key',
            fetch: stubFetch(captured, messagesOk),
        });
        await send(
            anthropic(MODEL),
            'anthropic',
            MODEL,
            { userPrefixes: [] },
            { anthropic: { cacheControl: { type: 'ephemeral' } } },
        );
        expect(JSON.stringify(captured.body)).not.toContain('cache_control');
    });

    it("keeps the slot's automatic cache on a call that declares none", async () => {
        const captured: Captured = { body: undefined };
        const anthropic = createAnthropic({
            apiKey: 'test-key',
            fetch: stubFetch(captured, messagesOk),
        });
        await send(anthropic(MODEL), 'anthropic', MODEL, undefined, {
            anthropic: { cacheControl: { type: 'ephemeral' } },
        });
        expect(captured.body.cache_control).toEqual({ type: 'ephemeral' });
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
                userPrefixes: [HEAD],
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

    it('marks the rules and the head with a breakpoint each', async () => {
        const captured: Captured = { body: undefined };
        const openai = createOpenAI({
            apiKey: 'test-key',
            fetch: stubFetch(captured, responsesOk),
        });
        await send(openai('gpt-6.1-sol'), 'openai', 'gpt-6.1-sol', {
            userPrefixes: [RULES, HEAD],
        });
        const user = captured.body.input.find((m: any) => m.role === 'user');
        expect(user.content).toEqual([
            {
                type: 'input_text',
                text: RULES,
                prompt_cache_breakpoint: { mode: 'explicit' },
            },
            {
                type: 'input_text',
                text: INTENT,
                prompt_cache_breakpoint: { mode: 'explicit' },
            },
            { type: 'input_text', text: TAIL },
        ]);
    });

    it('sends a declared call with nothing to mark in explicit mode with no breakpoint, so nothing is written', async () => {
        const captured: Captured = { body: undefined };
        const openai = createOpenAI({
            apiKey: 'test-key',
            fetch: stubFetch(captured, responsesOk),
        });
        await send(openai('gpt-6.1-sol'), 'openai', 'gpt-6.1-sol', {
            userPrefixes: [],
        });
        expect(JSON.stringify(captured.body.input)).not.toContain(
            'prompt_cache_breakpoint',
        );
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
            userPrefixes: [HEAD],
        });
        const user = captured.body.input.find((m: any) => m.role === 'user');
        expect(JSON.stringify(user)).not.toContain('prompt_cache_breakpoint');
        expect(captured.body.prompt_cache_options).toBeUndefined();
    });
});
