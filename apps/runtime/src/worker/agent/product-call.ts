import type { FetchLike } from './http-llm-gateway';

// What the worker's calls to the product share: a request the product never
// received (refused, unresolved, no connection, as fetch's TypeError cause
// carries it) is sent again after a pause, about two minutes in all, what an
// API restart takes. A request that may have reached the product is sent
// again only where the product deduplicates it (`resend: 'deduplicated'`:
// the same attempt answers what it stored); anywhere else it may have acted
// on it (run a model turn, minted a token), so it is never sent again.

/** Pauses before sending again a request the product never received. */
export const PRODUCT_CONNECT_RETRY_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

const NEVER_REACHED = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** Lost after the request may have reached the product: reset, hung up (undici's "other side closed"), headers or body too late. */
const MAY_HAVE_REACHED = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** The network code of a failure: fetch's TypeError carries it on its cause; a body read throws undici's error itself. */
const codeOf = (e: unknown): string | undefined => {
    if (!(e instanceof Error)) return undefined;
    const cause = (e as { cause?: unknown }).cause;
    const code = (cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined) ?? (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
};

/** The request never reached the product. */
export const neverReached = (e: unknown): boolean => {
    const cause = e instanceof Error ? (e as { cause?: unknown }).cause : undefined;
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    return typeof code === 'string' && NEVER_REACHED.has(code);
};

/** The request may have reached the product, and its answer was lost on the way back. */
export const mayHaveReached = (e: unknown): boolean => {
    const code = codeOf(e);
    return code !== undefined && MAY_HAVE_REACHED.has(code);
};

/** A 502 or 503 the product did not write (a load balancer while it restarts): no answer of the product's. */
export const productRestarting = (status: number, body: unknown): boolean =>
    (status === 502 || status === 503) && !(body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string');

/** The error's name and, for a network failure (fetch's TypeError), the code of its cause: `TypeError: UND_ERR_HEADERS_TIMEOUT`. */
export const failureName = (e: unknown): string => {
    if (!(e instanceof Error)) return 'error';
    const cause = (e as { cause?: unknown }).cause;
    const code = cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string' ? (cause as { code: string }).code : undefined;
    return code && /^[A-Z0-9_]{1,64}$/.test(code) ? `${e.name}: ${code}` : e.name;
};

/** apps/api's TransformInterceptor wraps every success as { statusCode, type, data }. */
export const unwrapProductBody = (body: unknown): unknown =>
    body && typeof body === 'object' && 'data' in body && typeof (body as { data: unknown }).data === 'object' ? (body as { data: unknown }).data : body;

export interface PostToProductOptions {
    timeoutMs: number;
    connectRetryDelaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /**
     * `deduplicated`: the product answers a repeat of this request with what
     * it stored, so one that may have reached it (a reset, a timeout, a 502
     * or 503 while it restarts) is sent again too, within the same pauses.
     */
    resend?: 'never_reached' | 'deduplicated';
    /** No send, and no pause, past this time (epoch ms on `now`); each send's own timeout ends there too. */
    deadline?: number;
    now?: () => number;
}

/** One POST of JSON to the product, sent again only while it is safe to (see PostToProductOptions.resend); the answer's status and body. */
export async function postToProduct(doFetch: FetchLike, url: string, token: string, body: unknown, opts: PostToProductOptions): Promise<{ res: Awaited<ReturnType<FetchLike>>; body: any }> {
    const delays = opts.connectRetryDelaysMs ?? PRODUCT_CONNECT_RETRY_MS;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.now ?? Date.now;
    const deduplicated = opts.resend === 'deduplicated';
    const fits = (ms: number) => opts.deadline === undefined || now() + ms < opts.deadline;
    for (let attempt = 0; ; attempt++) {
        const again = attempt < delays.length && fits(delays[attempt]);
        try {
            const timeoutMs = opts.deadline === undefined ? opts.timeoutMs : Math.max(1, Math.min(opts.timeoutMs, opts.deadline - now()));
            const res = await doFetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
            let answer: unknown;
            try {
                answer = await res.json();
            } catch (e) {
                // The body was lost on the way (not merely not JSON): where the product deduplicates, ask again.
                if (deduplicated && mayHaveReached(e)) throw e;
                answer = undefined;
            }
            if (deduplicated && again && productRestarting(res.status, answer)) {
                await sleep(delays[attempt]);
                continue;
            }
            return { res, body: answer };
        } catch (e) {
            if (!again || !(neverReached(e) || (deduplicated && mayHaveReached(e)))) throw e;
            await sleep(delays[attempt]);
        }
    }
}
