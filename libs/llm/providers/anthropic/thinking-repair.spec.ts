/**
 * Proves the anthropic-compatible thinking-signature repair: an unsigned `thinking`
 * block (Moonshot/Kimi, Z.ai/GLM) gets an empty `signature` injected so
 * @ai-sdk/anthropic@4's non-optional schema accepts the response; everything else is
 * left byte-for-byte, and non-JSON bodies pass through untouched.
 */
import { withThinkingSignatureRepair } from './thinking-repair';

const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });

/**
 * What these tests read off the repaired body. `Response.json()` is typed
 * `Promise<unknown>`, so the shape has to be stated rather than assumed —
 * naming it here keeps that statement in one place instead of three casts.
 */
interface AnthropicBody {
    content: Array<Record<string, unknown>>;
}

describe('withThinkingSignatureRepair', () => {
    it('injects an empty signature into an unsigned thinking block', async () => {
        const upstream = {
            type: 'message',
            content: [
                { type: 'thinking', thinking: 'reasoning...' },
                { type: 'text', text: 'pong' },
            ],
        };
        const wrapped = withThinkingSignatureRepair(async () =>
            jsonResponse(upstream),
        );

        const res = await wrapped('https://api.moonshot.ai/anthropic/v1/messages');
        const parsed = (await res.json()) as AnthropicBody;

        expect(parsed.content[0]).toEqual({
            type: 'thinking',
            thinking: 'reasoning...',
            signature: '',
        });
        // The text block and everything else is untouched.
        expect(parsed.content[1]).toEqual({ type: 'text', text: 'pong' });
        expect(res.status).toBe(200);
    });

    it('leaves an already-signed thinking block untouched (native Anthropic)', async () => {
        const upstream = {
            content: [
                { type: 'thinking', thinking: 'x', signature: 'real-sig' },
            ],
        };
        const wrapped = withThinkingSignatureRepair(async () =>
            jsonResponse(upstream),
        );

        const parsed = (await (
            await wrapped('https://api.anthropic.com/v1/messages')
        ).json()) as AnthropicBody;

        expect(parsed.content[0].signature).toBe('real-sig');
    });

    it('passes a non-JSON (streaming) body through unchanged', async () => {
        const sse = 'event: content_block_delta\ndata: {}\n\n';
        const wrapped = withThinkingSignatureRepair(
            async () =>
                new Response(sse, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                }),
        );

        const res = await wrapped('https://api.moonshot.ai/anthropic/v1/messages');
        expect(await res.text()).toBe(sse);
    });

    it('does not touch a plain response with no thinking blocks', async () => {
        const upstream = { content: [{ type: 'text', text: 'hi' }] };
        const wrapped = withThinkingSignatureRepair(async () =>
            jsonResponse(upstream),
        );

        const parsed = (await (
            await wrapped('https://api.moonshot.ai/anthropic/v1/messages')
        ).json()) as AnthropicBody;

        expect(parsed).toEqual(upstream);
    });
});
