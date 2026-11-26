/**
 * Native Anthropic thinking-block binding retry.
 *
 * Accounts Anthropic enforces the check on bind a signed `thinking` block to the
 * conversation it was created in, `tools` list included. The agent loop narrows
 * the tools near its step limit (ForceFinalizePolicy) while replaying earlier
 * thinking blocks, so the request is refused with a 400 and the review fails.
 *
 * Only that refusal is retried, once, asking the API to drop the blocks that no
 * longer match. Every other request goes out and comes back unchanged, so
 * accounts and models without the check never see the beta.
 */
type FetchFn = typeof fetch;

const BINDING_ERROR = 'bound to a different conversation';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

export function withThinkingBindingRetry(baseFetch: FetchFn): FetchFn {
    return async (input, init) => {
        const res = await baseFetch(input, init);
        if (res.status !== 400 || typeof init?.body !== 'string') return res;
        // Read a clone: the caller still needs the body of any other 400.
        if (!(await res.clone().text()).includes(BINDING_ERROR)) return res;

        const body = JSON.parse(init.body) as {
            thinking?: Record<string, unknown>;
        };
        body.thinking = {
            type: 'adaptive',
            ...body.thinking,
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
        };
        const headers = new Headers(init.headers);
        const betas = headers.get('anthropic-beta');
        headers.set(
            'anthropic-beta',
            betas ? `${betas},${BINDING_BETA}` : BINDING_BETA,
        );
        return baseFetch(input, {
            ...init,
            headers,
            body: JSON.stringify(body),
        });
    };
}
