// undici (Node's built-in fetch) ships a `headersTimeout` of 300_000ms.
// It fires INDEPENDENT of our AbortSignal — when Kodus's slow endpoints
// (e.g. Bitbucket `finish-onboarding` regularly takes 3–5 minutes while
// it clones, generates rules, and round-trips an LLM) don't send the
// first response byte by 5 minutes, the connection is killed with
// `TypeError: fetch failed` and the test sees a flaky network error.
//
// Install a custom undici Dispatcher with longer header/body timeouts on
// the global dispatcher so every `fetch` call in the test runner uses it.
// The bound is high enough (10 minutes) that legitimate hangs still
// surface, but well above the worst-case real onboarding latency we've
// measured.
import { Agent, setGlobalDispatcher } from "undici";

const TEN_MINUTES_MS = 10 * 60 * 1000;
setGlobalDispatcher(
    new Agent({
        headersTimeout: TEN_MINUTES_MS,
        bodyTimeout: TEN_MINUTES_MS,
    }),
);

export interface HttpOptions {
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
    status: number;
    headers: Headers;
    body: T;
    raw: string;
}

// Internal: one attempt of the actual fetch. Extracted so the retry
// branch below can re-issue without duplicating the (mildly tedious)
// AbortController + body-encoding + content-type ceremony.
async function attempt<T>(
    url: string,
    opts: HttpOptions,
    timeoutMs: number,
): Promise<HttpResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const init: RequestInit = {
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
        signal: controller.signal,
    };
    if (opts.body !== undefined && opts.body !== null) {
        init.body =
            typeof opts.body === "string"
                ? opts.body
                : JSON.stringify(opts.body);
        if (
            typeof init.body === "string" &&
            !(opts.headers && Object.keys(opts.headers).some((k) => k.toLowerCase() === "content-type"))
        ) {
            init.headers = {
                ...(init.headers as Record<string, string>),
                "Content-Type": "application/json",
            };
        }
    }

    try {
        const resp = await fetch(url, init);
        const raw = await resp.text();
        let body: unknown = raw;
        const ct = resp.headers.get("content-type") ?? "";
        if (ct.includes("application/json") && raw.length > 0) {
            try {
                body = JSON.parse(raw);
            } catch {
                /* leave raw */
            }
        }
        return {
            status: resp.status,
            headers: resp.headers,
            body: body as T,
            raw,
        };
    } finally {
        clearTimeout(timer);
    }
}

// Heuristic for "transport failed, retry might help" — distinct from
// "server returned 5xx" (which the caller's `ensureOk` decides). We
// only retry on errors thrown BEFORE we get an HTTP status: undici's
// `TypeError: fetch failed`, plain network reset, AbortError fired by
// our own timer (the request never completed). HTTP 5xx is excluded
// here because the caller may legitimately want to surface it without
// silent retry side effects (e.g. registration that's idempotent on
// pure transport, but not on 5xx-after-partial-write).
function isTransportError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message ?? "";
    return (
        err.name === "TypeError" && msg === "fetch failed"
    ) || (
        err.name === "AbortError"
    ) || /ECONNRESET|EPIPE|ETIMEDOUT|socket hang up/i.test(msg);
}

export async function http<T = unknown>(
    url: string,
    opts: HttpOptions = {},
): Promise<HttpResponse<T>> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    try {
        return await attempt<T>(url, opts, timeoutMs);
    } catch (err) {
        if (!isTransportError(err)) {
            throw err;
        }
        // One retry on transport failure. Concrete motivation: bitbucket
        // finish-onboarding takes ~91s server-side (generateKodyRules
        // makes ~72 sequential Bitbucket Cloud API calls, ~1.3s each)
        // and the long-idle TCP connection occasionally resets between
        // Mac and droplet before the 204 arrives, throwing
        // `TypeError: fetch failed`. On retry the server-side work is
        // cached (kody rules already generated) so the request returns
        // in ~1.8s. See [TIMING:onboarding] in finish-onboarding.use-
        // case.ts — confirmed 2026-05-22 fresh-tenant probe.
        await new Promise((r) => setTimeout(r, 1_000));
        return attempt<T>(url, opts, timeoutMs);
    }
}

export function ensureOk<T>(
    resp: HttpResponse<T>,
    label: string,
): HttpResponse<T> {
    if (resp.status >= 200 && resp.status < 300) return resp;
    throw new Error(
        `${label}: HTTP ${resp.status}\n${resp.raw.slice(0, 500)}`,
    );
}
