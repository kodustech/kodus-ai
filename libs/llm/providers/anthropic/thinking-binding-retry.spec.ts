/**
 * A native Anthropic request refused because a replayed `thinking` block is bound
 * to a different `tools` list is retried once with `drop_block`; nothing else is
 * touched.
 */
import { generateText } from 'ai';
import { anthropicModule } from './index';

const BINDING_MESSAGE =
    'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".';

const errorResponse = (message: string) =>
    new Response(
        JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
    );

const okResponse = () =>
    new Response(
        JSON.stringify({
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );

function run(...responses: Response[]) {
    const requests: Array<{ beta: string | null; body: any }> = [];
    const model = anthropicModule.build(
        {
            provider: 'anthropic',
            apiKey: 'test-key',
            model: 'claude-opus-5-5',
        } as any,
        {
            fetch: (async (_input: unknown, init: RequestInit) => {
                requests.push({
                    beta: new Headers(init.headers).get('anthropic-beta'),
                    body: JSON.parse(init.body as string),
                });
                return responses[requests.length - 1];
            }) as typeof fetch,
        },
    );
    const result = generateText({
        model,
        prompt: 'review this',
        maxRetries: 0,
        providerOptions: {
            anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
        },
    });
    return { requests, result };
}

describe('native Anthropic thinking-block binding retry', () => {
    it('retries the refused request once with drop_block and the beta', async () => {
        const { requests, result } = run(
            errorResponse(BINDING_MESSAGE),
            okResponse(),
        );

        expect((await result).text).toBe('done');
        expect(requests).toHaveLength(2);
        expect(requests[0].body.thinking).toEqual({ type: 'adaptive' });
        expect(requests[1].body.thinking).toEqual({
            type: 'adaptive',
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
        });
        expect(requests[1].beta).toContain(
            'thinking-binding-controls-2026-08-01',
        );
        expect(requests[1].body.messages).toEqual(requests[0].body.messages);
    });

    it('does not retry any other 400 and keeps its error', async () => {
        const { requests, result } = run(errorResponse('max_tokens too large'));

        await expect(result).rejects.toThrow('max_tokens too large');
        expect(requests).toHaveLength(1);
    });

    it('leaves a successful request unchanged', async () => {
        const { requests, result } = run(okResponse());

        await result;
        expect(requests).toHaveLength(1);
        expect(requests[0].body.thinking).toEqual({ type: 'adaptive' });
        expect(requests[0].beta ?? '').not.toContain('thinking-binding');
    });
});
