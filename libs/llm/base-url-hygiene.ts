/**
 * Base-URL hygiene — catch the endpoint path pasted into the BASE url.
 *
 * A provider SDK builds its request as `baseURL + <its own path>`
 * (`/chat/completions` for the OpenAI protocol, `/v1/messages` for Anthropic).
 * When a user copies the full endpoint out of a provider's cURL example into the
 * "Base URL" field, the path is appended a SECOND time and every call 404s:
 *
 *   stored   https://api.groq.com/openai/v1/chat/completions
 *   request  https://api.groq.com/openai/v1/chat/completions/chat/completions
 *
 * Nothing downstream can recover from this — the key is valid, the model is
 * valid, the URL resolves, and reviews just fail. It is only visible if someone
 * looks at the request URL, which is why it survived in production.
 *
 * We REPORT it rather than silently rewriting the URL: a base URL is the one
 * field where guessing on the user's behalf can send their API key somewhere
 * they did not intend.
 *
 * A dependency-free leaf (no NestJS, no registry) so the save path, the
 * connection probe and the model-listing fetcher can all share the one rule.
 */



/** Endpoint paths a provider SDK appends to the base URL itself. */
const APPENDED_ENDPOINT_PATHS = [
    '/chat/completions',
    '/v1/messages',
    '/messages',
    '/v1/responses',
    '/responses',
    '/completions',
    '/v1/chat/completions',
];

/**
 * Returns a human-actionable problem with a user-supplied base URL, or
 * `undefined` when it looks fine. Only reports problems that make the endpoint
 * UNUSABLE — it deliberately says nothing about a missing `/v1`, because plenty
 * of real upstreams (api.deepseek.com among them) serve both forms.
 */
export function describeBaseUrlProblem(rawUrl: string): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return undefined; // shape/protocol is the caller's own validation
    }

    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    const hit = APPENDED_ENDPOINT_PATHS.find((p) => path.endsWith(p));
    if (hit) {
        const suggested =
            parsed.origin + parsed.pathname.replace(/\/+$/, '').slice(0, -hit.length);
        return `Base URL must not include the "${hit}" endpoint — the provider appends it. Use "${suggested || parsed.origin}" instead.`;
    }

    return undefined;
}
