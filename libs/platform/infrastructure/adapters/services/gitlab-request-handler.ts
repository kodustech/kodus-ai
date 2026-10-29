import { createHash } from 'node:crypto';

import {
    createRequesterFn,
    getMatchingRateLimiter,
    GitbeakerRequestError,
    GitbeakerRetryError,
    GitbeakerTimeoutError,
    type FormattedResponse,
    type RateLimiters,
    type RequestHandlerFn,
} from '@gitbeaker/requester-utils';

import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('gitlab-request-handler');

/**
 * Request handler for `@gitbeaker/rest` that treats a 429 as "stop pushing".
 *
 * gitbeaker's own handler retries a 429 ten times with `delay(2 ** i * 0.25)`
 * in milliseconds, so it sends eleven requests in ~250ms, ignores
 * `Retry-After` and then drops the response. On gitlab.com that keeps the
 * account's quota pinned: on 2026-10-28 the self-hosted E2E cell answered
 * every call with 429 for 12 minutes straight after onboarding, and the
 * review it was there to test was skipped as rate-limited.
 *
 * Here a 429 is not retried. It puts the token in a cooldown for as long as
 * GitLab asks, and every call with that token fails locally until the
 * cooldown ends, so the callers that do retry (`with429Retry`, the RabbitMQ
 * republish) wait it out without spending more of the quota. The error keeps
 * the wait, so those callers sleep for exactly that long.
 *
 * 502 keeps gitbeaker's original behaviour.
 */

/** Used when a 429 carries no `Retry-After`: GitLab's limits are per minute. */
export const GITLAB_DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Longest cooldown we accept from a header. Past it we probe again: one
 * request every few minutes costs nothing, a wrong header costs an hour.
 */
export const GITLAB_MAX_RETRY_AFTER_MS = 5 * 60_000;

const RETRY_502_ATTEMPTS = 10;

// Token fingerprint (+ host) -> epoch ms until which the token is cooling down.
const cooldowns = new Map<string, number>();

export class GitlabRateLimitedError extends GitbeakerRetryError {
    readonly status = 429;
    readonly retryAfterMs: number;
    /** Same shape `with429Retry` reads `Retry-After` from. */
    readonly headers: Record<string, string>;

    constructor(retryAfterMs: number, origin: string, fromCooldown: boolean) {
        const seconds = Math.ceil(retryAfterMs / 1000);
        super(
            fromCooldown
                ? `GitLab rate limit (HTTP 429) still cooling down on ${origin}; retry after ${seconds}s`
                : `GitLab answered HTTP 429 on ${origin}; retry after ${seconds}s`,
        );
        // Keep the name gitbeaker used, so `isGitlabRateLimitError` and
        // `is429Error` keep recognising it.
        this.name = 'GitbeakerRetryError';
        this.retryAfterMs = retryAfterMs;
        this.headers = { 'retry-after': String(seconds) };
    }
}

export function resetGitlabCooldowns(): void {
    cooldowns.clear();
}

export function parseGitlabRetryAfterMs(
    headers: Headers,
    now: number = Date.now(),
): number {
    const retryAfter = headers.get('retry-after');
    if (retryAfter != null && retryAfter.trim() !== '') {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return clampRetryAfter(seconds * 1000);
        }
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) {
            return clampRetryAfter(date - now);
        }
    }
    // RateLimit-Reset is the epoch second the window resets.
    const reset = Number(headers.get('ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
        return clampRetryAfter(reset * 1000 - now);
    }
    return GITLAB_DEFAULT_RETRY_AFTER_MS;
}

function clampRetryAfter(ms: number): number {
    return Math.min(Math.max(ms, 1_000), GITLAB_MAX_RETRY_AFTER_MS);
}

function cooldownKey(origin: string, headers: unknown): string {
    const h = (headers ?? {}) as Record<string, unknown>;
    const credential = String(
        h.authorization ?? h['private-token'] ?? h['job-token'] ?? '',
    );
    const fingerprint = createHash('sha256')
        .update(credential)
        .digest('hex')
        .slice(0, 16);
    return `${origin}|${fingerprint}`;
}

async function processBody(response: Response) {
    const contentType = (response.headers.get('content-type') || '')
        .split(';')[0]
        .trim();
    if (contentType === 'application/json') {
        return response.json().then((v) => v || {});
    }
    if (contentType.startsWith('text/')) {
        return response.text().then((t) => t || '');
    }
    return response.blob();
}

async function parseResponse(
    response: Response,
    asStream = false,
): Promise<FormattedResponse> {
    const { status, headers: rawHeaders } = response;
    const headers = Object.fromEntries(rawHeaders.entries());
    const body = asStream
        ? response.body
        : status === 204
          ? null
          : await processBody(response);
    return { body, headers, status } as FormattedResponse;
}

async function throwFailedRequestError(
    request: Request,
    response: Response,
): Promise<never> {
    const content = await response.text();
    const contentType = response.headers.get('Content-Type');
    let description: string;
    if (contentType?.includes('application/json')) {
        const output = JSON.parse(content);
        const contentProperty = output?.error || output?.message || '';
        description =
            typeof contentProperty === 'string'
                ? contentProperty
                : JSON.stringify(contentProperty);
    } else {
        description = content;
    }
    throw new GitbeakerRequestError(description, {
        cause: { description, request, response },
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const gitlabRequestHandler: RequestHandlerFn = async (
    endpoint,
    options,
) => {
    const {
        rateLimiters,
        agent,
        asStream,
        prefixUrl,
        searchParams,
        method,
        ...opts
    } = (options || {}) as Record<string, any>;
    const rateLimit = getMatchingRateLimiter(
        endpoint,
        rateLimiters as RateLimiters,
        method,
    );

    let baseUrl: string | undefined;
    if (prefixUrl) {
        baseUrl = prefixUrl.endsWith('/') ? prefixUrl : `${prefixUrl}/`;
    }
    const url = new URL(endpoint, baseUrl);
    url.search = searchParams || '';
    const mode = endpoint.includes('repository/archive')
        ? 'same-origin'
        : undefined;
    const key = cooldownKey(url.origin, opts.headers);

    for (let i = 0; i < RETRY_502_ATTEMPTS; i += 1) {
        const coolingUntil = cooldowns.get(key);
        if (coolingUntil !== undefined) {
            const remaining = coolingUntil - Date.now();
            if (remaining > 0) {
                throw new GitlabRateLimitedError(remaining, url.origin, true);
            }
            cooldowns.delete(key);
        }

        const request = new Request(url, { ...opts, method, mode });
        await rateLimit();
        const response = await (
            agent
                ? fetch(request, { dispatcher: agent } as RequestInit)
                : fetch(request)
        ).catch((e) => {
            if (e.name === 'TimeoutError' || e.name === 'AbortError') {
                throw new GitbeakerTimeoutError('Query timeout was reached');
            }
            throw e;
        });

        if (response.ok) return parseResponse(response, asStream);

        if (response.status === 429) {
            const retryAfterMs = parseGitlabRetryAfterMs(response.headers);
            cooldowns.set(key, Date.now() + retryAfterMs);
            logger.warn({
                message: `GitLab 429 on ${method} ${url.pathname}; cooling the token down for ${retryAfterMs}ms`,
                context: 'gitlabRequestHandler',
                metadata: {
                    origin: url.origin,
                    retryAfterMs,
                    rateLimitLimit: response.headers.get('ratelimit-limit'),
                    rateLimitObserved:
                        response.headers.get('ratelimit-observed'),
                    rateLimitRemaining: response.headers.get(
                        'ratelimit-remaining',
                    ),
                    rateLimitName: response.headers.get('ratelimit-name'),
                },
            });
            throw new GitlabRateLimitedError(retryAfterMs, url.origin, false);
        }

        if (response.status !== 502) {
            await throwFailedRequestError(request, response);
        }
        await delay(2 ** i * 0.25);
    }

    throw new GitbeakerRetryError(
        `Could not successfully complete this request after ${RETRY_502_ATTEMPTS} retries, last status code: 502. Verify the status of the endpoint.`,
    );
};

export const gitlabRequesterFn = createRequesterFn(
    (_, requestOptions) => Promise.resolve(requestOptions),
    gitlabRequestHandler,
);
