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
import { logger } from "./log.js";

const log = logger("http");

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
    // "manual" surfaces 3xx responses instead of following them — needed
    // by callers that assert ON the redirect itself (e.g. the RBAC route
    // guard checking for a /forbidden Location). Default: fetch's "follow".
    redirect?: "follow" | "manual";
}

export interface HttpResponse<T = unknown> {
    status: number;
    headers: Headers;
    body: T;
    raw: string;
}

// AWS WAF on the QA ALB intermittently blocks GitHub-hosted runner IPs
// (shared pool → some land on the IP-reputation/rate rules), 403-ing the
// ENTIRE run. The WAF carries an Allow rule keyed on this secret header;
// inject it on every request bound for a `qa.*.kodus.io` host — and ONLY
// those: the secret must never reach github.com/gitlab.com/etc. No-op when
// QA_WAF_BYPASS_HEADER is unset (local runs, forks).
export function wafBypassHeader(url: string): Record<string, string> {
    const secret = process.env.QA_WAF_BYPASS_HEADER;
    if (!secret) return {};
    try {
        const host = new URL(url).hostname;
        if (/^qa\.([a-z0-9-]+\.)*kodus\.io$/i.test(host)) {
            return { "x-kodus-e2e": secret };
        }
    } catch {
        // unparsable URL → fetch() will fail with its own error anyway
    }
    return {};
}

// Session-cookie jar, keyed by the bearer access token.
//
// The cloud matrix reaches the API through the web app's `/api/proxy/api`
// route, which is the SINGLE authority on the upstream `Authorization`
// header: it derives the Bearer from the NextAuth SESSION COOKIE and DELETES
// any client-sent Authorization when there's no session (see
// apps/web/.../api/proxy/api/[...path]/route.ts). A raw `Authorization:
// Bearer <token>` therefore never reaches the backend through the proxy —
// requests must carry the NextAuth session cookie instead. The cloud login
// flow establishes that cookie (see establishWebSession in onboarding.ts) and
// registers it here against the access token; every request that carries that
// exact bearer then also gets the cookie, with no per-call-site changes.
// Keyed by access token so concurrent cloud tenants on the SAME host don't
// cross-contaminate cookies. Direct (local / self-hosted) targets never
// register anything, so this is a no-op there.
const sessionCookieJar = new Map<string, { cookie: string; host: string }>();

export function registerSessionCookie(
    accessToken: string,
    cookie: string,
    host: string,
): void {
    sessionCookieJar.set(accessToken, { cookie, host });
}

function bearerToken(
    headers: Record<string, string> | undefined,
): string | undefined {
    if (!headers) return undefined;
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === "authorization") {
            const m = /^Bearer\s+(.+)$/i.exec(v);
            return m?.[1];
        }
    }
    return undefined;
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

    const headers: Record<string, string> = {
        ...(opts.headers ?? {}),
        ...wafBypassHeader(url),
    };
    // Attach the NextAuth session cookie for the registered bearer so proxied
    // cloud calls authenticate (the proxy reads the cookie, not the Bearer).
    // Host-scoped: the cookie is a credential for the web host that issued it
    // and must NEVER ride along to a different host (e.g. a github.com /
    // gitlab.com provider call that happens to reuse a bearer) — same
    // defensive posture as wafBypassHeader.
    const token = bearerToken(opts.headers);
    const entry = token ? sessionCookieJar.get(token) : undefined;
    if (entry) {
        let sameHost = false;
        try {
            sameHost = new URL(url).host === entry.host;
        } catch {
            sameHost = false;
        }
        if (sameHost) {
            const existing = headers.Cookie ?? headers.cookie;
            headers.Cookie = existing
                ? `${existing}; ${entry.cookie}`
                : entry.cookie;
        }
    }

    const init: RequestInit = {
        method: opts.method ?? "GET",
        headers,
        signal: controller.signal,
        ...(opts.redirect ? { redirect: opts.redirect } : {}),
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

// Transport-error retry budget. A freshly-provisioned self-hosted droplet
// can take several seconds AFTER the `api up` healthcheck before undici can
// actually open a keep-alive socket to :3001 — the NestJS app finishes
// wiring routes, the kernel finishes accepting on the published port, and
// the first cross-host connection sometimes resets. We observed (2026-05-29,
// bitbucket cell) ALL 6 scenarios fail with `fetch failed` in a 9s window
// while a sibling github cell on its own droplet passed — pure transport
// flakiness, not an app or test bug. A single 1s retry didn't cover it.
//
// Exponential backoff (1s, 2s, 4s, 8s, 16s → ~31s total) absorbs that
// window without masking real failures: a 4xx/5xx is NOT a transport error
// and throws immediately via ensureOk downstream, so a genuinely-broken
// endpoint still fails fast. Only `fetch failed` / ECONNRESET / AbortError
// get retried.
const TRANSPORT_RETRIES = 5;

// HTTP 429 retry budget. Bitbucket Cloud rate-limits the shared test account
// hard: the runner's pollForReview loop (one list-comments call every 10s for
// up to 10min) plus the review worker's own Bitbucket calls overrun the
// per-account quota and Bitbucket returns 429 with a Retry-After header. A
// single 429 also cascades — the next scenario's PAT re-validation goes
// through Kodus to Bitbucket and comes back as 400 "Error authenticating".
// Honouring Retry-After here makes the whole thing deterministic: we wait
// exactly as long as Bitbucket asks (capped) and retry, so no rate-limit
// blip ever surfaces as a test failure. Applies to every provider but only
// Bitbucket realistically hits it.
const RATE_LIMIT_RETRIES = 6;
const RETRY_AFTER_CAP_MS = 60_000;

// GitHub does NOT use 429 for its rate limits — it answers 403 and puts the
// reason in the headers. That is why the Retry-After handling above never
// fired for GitHub: the matrix saw a bare 403, the runner classified it as
// "quota exhausted", and SKIPPED the whole cell. On the 2026-08-07 release
// gate that cost five P0 cells; the github×free and github×community-byok
// columns executed nothing at all.
//
// Most of those are SECONDARY limits (content-creation bursts on the
// abuse-flagged bot accounts), which GitHub asks us to retry within ~60s.
// Waiting is strictly better than losing the coverage. PRIMARY limits reset
// on the hour, which is NOT worth waiting for inside a job — those still
// surface as the rate-limit error and skip.
//
// Cap: how long we are willing to sit still for quota. Anything beyond it is
// reported rather than waited out.
const GITHUB_QUOTA_WAIT_CAP_MS = Number(
    process.env.E2E_GITHUB_QUOTA_WAIT_CAP_MS ?? 5 * 60_000,
);

/**
 * Wait implied by a GitHub rate-limit response, or null when this is not a
 * rate-limit response (a plain 403 for missing scopes must NOT be retried —
 * it would turn a permission bug into a silent 5-minute stall).
 */
export function githubRateLimitWaitMs(
    resp: Pick<HttpResponse<unknown>, "status" | "headers" | "raw">,
    now: number = Date.now(),
): number | null {
    if (resp.status !== 403 && resp.status !== 429) return null;

    const remaining = resp.headers.get("x-ratelimit-remaining");
    const looksSecondary =
        /secondary rate limit|abuse detection/i.test(resp.raw ?? "");
    const looksPrimary = remaining === "0";
    // A retry-after on a 403 is GitHub explicitly telling us to wait.
    const retryAfter = resp.headers.get("retry-after");

    if (!looksSecondary && !looksPrimary && !retryAfter) return null;

    if (retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs) && secs >= 0) return secs * 1_000;
    }
    const reset = resp.headers.get("x-ratelimit-reset");
    if (reset) {
        const resetMs = Number(reset) * 1_000;
        if (Number.isFinite(resetMs)) return Math.max(0, resetMs - now);
    }
    // Secondary limit with no guidance: GitHub's documented advice is ~60s.
    return looksSecondary ? 60_000 : null;
}

function retryAfterMs(resp: HttpResponse<unknown>, attempt: number): number {
    const header = resp.headers.get("retry-after");
    if (header) {
        const secs = Number(header);
        if (Number.isFinite(secs) && secs >= 0) {
            return Math.min(secs * 1_000, RETRY_AFTER_CAP_MS);
        }
    }
    // No/!numeric header → exponential backoff 2s,4s,8s… capped.
    return Math.min(2_000 * 2 ** attempt, RETRY_AFTER_CAP_MS);
}

export async function http<T = unknown>(
    url: string,
    opts: HttpOptions = {},
): Promise<HttpResponse<T>> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let lastErr: unknown;
    let rateLimitHits = 0;
    for (let i = 0; i <= TRANSPORT_RETRIES; i++) {
        try {
            const resp = await attempt<T>(url, opts, timeoutMs);
            // 429 isn't an exception — it's a valid response we choose to
            // retry. Don't count it against the transport budget.
            if (resp.status === 429 && rateLimitHits < RATE_LIMIT_RETRIES) {
                const delay = retryAfterMs(resp, rateLimitHits);
                rateLimitHits++;
                log.info(
                    `[http] 429 on ${opts.method ?? "GET"} ${url} (rate-limit ${rateLimitHits}/${RATE_LIMIT_RETRIES}) — waiting ${delay}ms`,
                );
                await new Promise((r) => setTimeout(r, delay));
                i--; // this loop turn didn't consume a transport retry
                continue;
            }
            // GitHub's 403-shaped rate limits. Waiting out a short reset buys
            // back a cell we would otherwise report as unverified; a long one
            // (primary quota, resets hourly) is handed back to the caller so
            // it surfaces as the rate-limit error and skips honestly.
            if (resp.status === 403 && rateLimitHits < RATE_LIMIT_RETRIES) {
                const wait = githubRateLimitWaitMs(resp);
                if (wait !== null && wait <= GITHUB_QUOTA_WAIT_CAP_MS) {
                    rateLimitHits++;
                    log.info(
                        `[http] GitHub rate limit on ${opts.method ?? "GET"} ${url} (${rateLimitHits}/${RATE_LIMIT_RETRIES}) — waiting ${Math.round(wait / 1000)}s for the reset instead of dropping the cell`,
                    );
                    await new Promise((r) => setTimeout(r, wait));
                    i--;
                    continue;
                }
                if (wait !== null) {
                    log.info(
                        `[http] GitHub rate limit on ${url} needs ${Math.round(wait / 1000)}s — beyond the ${Math.round(GITHUB_QUOTA_WAIT_CAP_MS / 1000)}s cap, surfacing instead of stalling the job`,
                    );
                }
            }
            return resp;
        } catch (err) {
            if (!isTransportError(err)) {
                throw err;
            }
            lastErr = err;
            if (i === TRANSPORT_RETRIES) break;
            // 1s, 2s, 4s, 8s, 16s
            const delay = 1_000 * 2 ** i;
            log.info(
                `[http] transport error on ${opts.method ?? "GET"} ${url} (attempt ${i + 1}/${TRANSPORT_RETRIES + 1}) — retrying in ${delay}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
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
