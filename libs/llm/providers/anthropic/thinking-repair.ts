/**
 * Anthropic-compatible thinking-block repair.
 *
 * Anthropic-compatible upstreams (Moonshot/Kimi, Z.ai/GLM, DeepSeek-reasoner) return
 * `thinking` content blocks WITHOUT the `signature` field that `@ai-sdk/anthropic`
 * requires — its response schema types `signature` as a NON-optional string, so the
 * SDK rejects the entire response as "Invalid JSON response" and the review fails,
 * even though the body is valid JSON and the model answered correctly. (Native
 * Anthropic always signs its thinking, so this only affects the compatible endpoints.)
 *
 * This wraps the transport `fetch`: for a JSON (non-streaming) response it injects an
 * empty `signature` into any unsigned `thinking` block before the SDK parses it, and
 * leaves everything else byte-for-byte. Non-JSON bodies (SSE streams) pass through
 * untouched — the code-review loop runs `generateText` (non-streaming), so the JSON
 * path is the one it hits. The empty signature is inert: it is a passthrough marker
 * the compatible upstream never validates on the next turn.
 *
 * KNOWN LIMITATIONS (accepted — no consumer hits them today):
 *  - STREAMING (SSE) is passed through unrepaired: a future `streamText` consumer
 *    on a compatible thinking model would re-hit the unsigned-block rejection. The
 *    repair would then need to run on the decoded event stream, not the JSON body.
 *  - Only `type:'thinking'` blocks are signed; a `redacted_thinking` block (which
 *    also carries a signature in the native schema) is not patched. No compatible
 *    upstream is known to emit one, so this stays unhandled until one does.
 */
// Match the ambient `fetch` signature rather than naming DOM types directly:
// `RequestInfo` is absent in a Node/ts-node compile without the DOM lib (it broke
// the structured-outputs repro), and the AI SDK expects a drop-in `fetch` anyway.
type FetchFn = typeof fetch;

export function withThinkingSignatureRepair(baseFetch: FetchFn): FetchFn {
    return async (input, init) => {
        const res = await baseFetch(input, init);
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) return res;

        const text = await res.text();
        let body = text;
        try {
            const json = JSON.parse(text) as { content?: unknown };
            if (Array.isArray(json.content)) {
                let patched = false;
                json.content = json.content.map((block) => {
                    const b = block as { type?: string; signature?: unknown };
                    if (b && b.type === 'thinking' && b.signature == null) {
                        patched = true;
                        return { ...b, signature: '' };
                    }
                    return block;
                });
                if (patched) body = JSON.stringify(json);
            }
        } catch {
            // Not JSON we can repair (or already valid) — return the body verbatim.
        }
        return new Response(body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
        });
    };
}
