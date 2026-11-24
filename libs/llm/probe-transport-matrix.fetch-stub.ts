/**
 * A stand-in for Node's global `fetch` that answers provider calls in-process
 * and follows the WHATWG redirect modes the way Node's bundled undici does.
 *
 * Why the redirect modes have to be faithful: `noRedirectFetch` does not
 * refuse a redirect itself, it hands `redirect: 'error'` to the global fetch
 * and relies on the runtime to refuse. A stub that ignored the option would
 * make every row pass or every row fail for the wrong reason. Read from
 * undici (`lib/web/fetch/index.js`, httpNetworkOrCacheFetch step 8, and the
 * fetch() resolution step) and checked against Node 22's fetch on a loopback
 * server:
 *
 *   - `error`  → the redirect response becomes a network error, so fetch
 *                rejects with `TypeError('fetch failed')` whose `cause` is
 *                `Error('unexpected redirect')`; the Location is never
 *                requested.
 *   - `manual` → the 30x response is returned as is.
 *   - `follow` (the default) → the Location is requested; 303, or 301/302 on
 *                a POST, turn into a body-less GET (HTTP-redirect fetch
 *                step 12). Capped at 20 hops.
 *
 * Every host the stub is asked for is recorded, so a spec can say which hosts
 * a probe reached. A host with no route rejects like a DNS failure would, and
 * nothing ever leaves the process.
 */

export type Route =
    /** Answer 30x with a Location on `toOrigin`, same path and query: a
     *  follower then gets a real provider answer there, so following would
     *  make the call succeed. */
    | {
          kind: 'redirect';
          status?: 301 | 302 | 303 | 307 | 308;
          toOrigin: string;
      }
    /** Answer like the provider would. */
    | { kind: 'answer' };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

function urlOf(input: unknown): URL {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof (input as Request).url === 'string') {
        return new URL((input as Request).url);
    }
    throw new TypeError(`fetch stub: unreadable input ${String(input)}`);
}

function methodOf(input: unknown, init?: RequestInit): string {
    return (
        init?.method ??
        (input && typeof (input as Request).method === 'string'
            ? (input as Request).method
            : 'GET')
    ).toUpperCase();
}

/** A minimal successful answer in the wire format the path belongs to. */
export function providerAnswer(url: URL): Response {
    const path = url.pathname;
    const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });

    // Anthropic Messages, native, compatible, and Claude on Vertex.
    if (path.endsWith('/messages') || path.endsWith(':rawPredict')) {
        return json({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'stub',
            content: [{ type: 'text', text: 'pong' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
        });
    }
    // Gemini, on AI Studio and on Vertex.
    if (path.endsWith(':generateContent')) {
        return json({
            candidates: [
                {
                    content: { role: 'model', parts: [{ text: 'pong' }] },
                    finishReason: 'STOP',
                    index: 0,
                },
            ],
            usageMetadata: {
                promptTokenCount: 1,
                candidatesTokenCount: 1,
                totalTokenCount: 2,
            },
        });
    }
    // OpenAI Responses (native OpenAI and Azure).
    if (path.endsWith('/responses')) {
        return json({
            id: 'resp_stub',
            object: 'response',
            created_at: 1,
            model: 'stub',
            status: 'completed',
            error: null,
            incomplete_details: null,
            output: [
                {
                    type: 'message',
                    id: 'msg_stub',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                        { type: 'output_text', text: 'pong', annotations: [] },
                    ],
                },
            ],
            usage: {
                input_tokens: 1,
                output_tokens: 1,
                total_tokens: 2,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
            },
        });
    }
    // Chat Completions (compatible endpoints, OpenRouter, Novita).
    if (path.endsWith('/chat/completions')) {
        return json({
            id: 'chatcmpl_stub',
            object: 'chat.completion',
            created: 1,
            model: 'stub',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: 'pong' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
    }
    // Bedrock Converse.
    if (path.endsWith('/converse')) {
        return json({
            output: {
                message: { role: 'assistant', content: [{ text: 'pong' }] },
            },
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
    }
    return new Response(`fetch stub: no answer for ${path}`, { status: 404 });
}

export interface FetchStub {
    fetch: typeof fetch;
    /** Every host asked for, in order, one entry per request (hops included). */
    hosts: string[];
    /** The `redirect` mode each request carried (undefined = default follow). */
    redirectModes: Array<RequestRedirect | undefined>;
}

export function createFetchStub(routes: Record<string, Route>): FetchStub {
    const hosts: string[] = [];
    const redirectModes: Array<RequestRedirect | undefined> = [];

    const hop = async (
        url: URL,
        method: string,
        init: RequestInit | undefined,
        count: number,
    ): Promise<Response> => {
        hosts.push(url.host);
        const route = routes[url.host];
        if (!route) {
            // What undici reports when the name does not resolve.
            throw new TypeError('fetch failed', {
                cause: new Error(`getaddrinfo ENOTFOUND ${url.hostname}`),
            });
        }
        if (route.kind === 'answer') return providerAnswer(url);

        const status = route.status ?? 302;
        const location = new URL(url.pathname + url.search, route.toOrigin);
        if (!REDIRECT_STATUSES.has(status)) {
            throw new Error(`fetch stub: ${status} is not a redirect`);
        }
        const mode = init?.redirect ?? 'follow';
        if (mode === 'error') {
            throw new TypeError('fetch failed', {
                cause: new Error('unexpected redirect'),
            });
        }
        if (mode === 'manual') {
            return new Response(null, {
                status,
                headers: { location: location.href },
            });
        }
        if (count >= MAX_REDIRECTS) {
            throw new TypeError('fetch failed', {
                cause: new Error('redirect count exceeded'),
            });
        }
        const toGet =
            status === 303 ||
            ((status === 301 || status === 302) && method === 'POST');
        return hop(
            location,
            toGet ? 'GET' : method,
            toGet ? { ...init, method: 'GET', body: undefined } : init,
            count + 1,
        );
    };

    const stub = (async (input: unknown, init?: RequestInit) => {
        redirectModes.push(init?.redirect);
        return hop(urlOf(input), methodOf(input, init), init, 0);
    }) as typeof fetch;

    return { fetch: stub, hosts, redirectModes };
}

/** Walk an error's `cause` chain (the AI SDK wraps the fetch TypeError). */
export function causeChain(error: unknown): unknown[] {
    const out: unknown[] = [];
    let current: unknown = error;
    while (current != null && out.length < 10) {
        out.push(current);
        current = (current as { cause?: unknown }).cause;
    }
    return out;
}
