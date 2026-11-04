/**
 * The cache marker Kodus stamps for Claude-on-Bedrock must survive the real
 * `@ai-sdk/amazon-bedrock` serializer and reach Converse as `cachePoint`
 * blocks. A marker the adapter does not read is dropped without a warning,
 * which is how every Bedrock Claude review ran with zero cache reads. Offline:
 * fetch is intercepted, AWS is never called.
 */
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { applyCacheBreakpoints } from './prompt-cache';

const MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

async function captureConverseBody(model: string): Promise<any> {
    let body: any;
    const fetchStub = (async (_url: unknown, init?: { body?: unknown }) => {
        body = JSON.parse(String(init?.body));
        return new Response(
            JSON.stringify({
                output: {
                    message: { role: 'assistant', content: [{ text: 'ok' }] },
                },
                stopReason: 'end_turn',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as unknown as typeof fetch;

    const bedrock = createAmazonBedrock({
        region: 'us-east-1',
        apiKey: 'test-key',
        fetch: fetchStub,
    });

    const { systemArg, callMessages, callTools } = applyCacheBreakpoints({
        system: 'You are a code reviewer.',
        messages: [{ role: 'user', content: 'Review this diff.' }],
        tools: {
            readFile: tool({
                description: 'Read a file',
                inputSchema: z.object({ path: z.string() }),
            }),
        },
        maxSteps: 5,
        provider: 'amazon_bedrock',
        model,
    });

    await generateText({
        model: bedrock(model),
        system: systemArg as any,
        messages: callMessages,
        tools: callTools,
    });
    return body;
}

const countCachePoints = (blocks: any[] | undefined) =>
    (blocks ?? []).filter((b) => b && 'cachePoint' in b).length;

describe('Bedrock prompt cache reaches the Converse request', () => {
    it('serializes a cachePoint after the system prompt and the latest user message for Claude', async () => {
        const body = await captureConverseBody(MODEL);

        expect(countCachePoints(body.system)).toBe(1);
        const lastUser = [...body.messages]
            .reverse()
            .find((m: any) => m.role === 'user');
        expect(countCachePoints(lastUser.content)).toBe(1);
    });

    it('sends no cachePoint for a non-Claude Bedrock model', async () => {
        const body = await captureConverseBody('amazon.nova-pro-v1:0');

        expect(countCachePoints(body.system)).toBe(0);
        for (const m of body.messages) {
            expect(countCachePoints(m.content)).toBe(0);
        }
    });
});
