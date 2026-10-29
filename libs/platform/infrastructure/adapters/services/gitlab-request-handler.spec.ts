import {
    is429Error,
    with429Retry,
} from '@libs/core/infrastructure/http/rate-limit-retry';

import {
    GITLAB_DEFAULT_RETRY_AFTER_MS,
    GITLAB_MAX_RETRY_AFTER_MS,
    gitlabRequestHandler,
    parseGitlabRetryAfterMs,
    resetGitlabCooldowns,
} from './gitlab-request-handler';
import {
    isGitlabRateLimitError,
    toGitlabRateLimitError,
} from './gitlab-rate-limit.util';

/**
 * gitbeaker's own handler answered a 429 with ten more requests in ~250ms and
 * no regard for Retry-After, which kept the gitlab.com token in 429 for the
 * whole self-hosted E2E cell. These pin the replacement: one request per 429,
 * then local failures until GitLab's wait is over.
 */

const PREFIX = 'https://gitlab.example.com/api/v4/';

function options(token = 'Bearer token-a') {
    return {
        prefixUrl: PREFIX,
        method: 'GET',
        headers: { authorization: token },
    };
}

function jsonResponse(status: number, body: unknown, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

describe('gitlabRequestHandler', () => {
    const realFetch = global.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        resetGitlabCooldowns();
        fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        global.fetch = realFetch;
        jest.useRealTimers();
    });

    it('returns the parsed body on success', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 7 }));

        const result = await gitlabRequestHandler('user', options());

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ id: 7 });
    });

    it('sends one request on a 429 and carries the Retry-After wait', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                429,
                { message: 'Rate limit exceeded' },
                { 'retry-after': '44' },
            ),
        );

        const error = await gitlabRequestHandler('user', options()).catch(
            (e) => e,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(error.retryAfterMs).toBe(44_000);
        expect(error.headers).toEqual({ 'retry-after': '44' });
        expect(is429Error(error)).toBe(true);
        expect(isGitlabRateLimitError(error)).toBe(true);
    });

    it('fails locally for the same token while the cooldown lasts', async () => {
        jest.useFakeTimers({ now: 1_000_000 });
        fetchMock.mockResolvedValueOnce(
            jsonResponse(429, {}, { 'retry-after': '30' }),
        );
        await gitlabRequestHandler('user', options()).catch(() => undefined);

        jest.setSystemTime(1_000_000 + 10_000);
        const error = await gitlabRequestHandler(
            'projects/1/merge_requests/2/notes',
            options(),
        ).catch((e) => e);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(error.retryAfterMs).toBe(20_000);
        expect(is429Error(error)).toBe(true);
    });

    it('goes back to the network once the cooldown is over', async () => {
        jest.useFakeTimers({ now: 1_000_000 });
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse(429, {}, { 'retry-after': '30' }),
            )
            .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
        await gitlabRequestHandler('user', options()).catch(() => undefined);

        jest.setSystemTime(1_000_000 + 30_001);
        const result = await gitlabRequestHandler('user', options());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.body).toEqual({ ok: true });
    });

    it('does not cool down a different token', async () => {
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse(429, {}, { 'retry-after': '30' }),
            )
            .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
        await gitlabRequestHandler('user', options('Bearer token-a')).catch(
            () => undefined,
        );

        const result = await gitlabRequestHandler(
            'user',
            options('Bearer token-b'),
        );

        expect(result.body).toEqual({ ok: true });
    });

    // gitlab.com caps note creation at 60/min per user. Publishing comments
    // too fast must not stop the same org's other reviews from reading.
    it('cools only the endpoint on a per-endpoint limit', async () => {
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse(
                    429,
                    {
                        message:
                            'This endpoint has been requested too many times. Try again later.',
                    },
                    { 'retry-after': '30' },
                ),
            )
            .mockResolvedValueOnce(jsonResponse(200, { id: 1 }));
        const notes = 'projects/1/merge_requests/2/discussions';
        const post = { ...options(), method: 'POST' };
        await gitlabRequestHandler(notes, post).catch(() => undefined);

        const read = await gitlabRequestHandler('user', options());
        const again = await gitlabRequestHandler(notes, post).catch((e) => e);

        expect(read.body).toEqual({ id: 1 });
        expect(is429Error(again)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('cools the whole token on the per-user limit', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                'Rate limit exceeded; see https://docs.gitlab.com/user/gitlab_com/rate_limits/ for more details',
                { status: 429, headers: { 'retry-after': '30' } },
            ),
        );
        await gitlabRequestHandler('projects/1/merge_requests/2/discussions', {
            ...options(),
            method: 'POST',
        }).catch(() => undefined);

        const read = await gitlabRequestHandler('user', options()).catch(
            (e) => e,
        );

        expect(is429Error(read)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('lets with429Retry wait the cooldown out with two requests, not forty', async () => {
        jest.useFakeTimers({ now: 1_000_000, advanceTimers: true });
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse(429, {}, { 'retry-after': '2' }),
            )
            .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

        const result = await with429Retry(
            () => gitlabRequestHandler('user', options()),
            { label: 'spec' },
        );

        expect(result.body).toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps retrying a 502 like gitbeaker did', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(502, {}))
            .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

        const result = await gitlabRequestHandler('user', options());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.body).toEqual({ ok: true });
    });

    it('raises other failures with the response, as gitbeaker did', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(404, { message: '404 Not Found' }),
        );

        const error = await gitlabRequestHandler('user', options()).catch(
            (e) => e,
        );

        expect(error.name).toBe('GitbeakerRequestError');
        expect(error.cause.response.status).toBe(404);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('feeds the wait into the RateLimitError the queue republishes on', async () => {
        jest.useFakeTimers({ now: 1_000_000 });
        fetchMock.mockResolvedValueOnce(
            jsonResponse(429, {}, { 'retry-after': '45' }),
        );
        const error = await gitlabRequestHandler('user', options()).catch(
            (e) => e,
        );

        const rateLimitError = toGitlabRateLimitError(error);

        expect(rateLimitError.resetAt.getTime()).toBe(1_000_000 + 45_000);
    });
});

describe('parseGitlabRetryAfterMs', () => {
    const now = 1_700_000_000_000;

    it('reads seconds', () => {
        expect(
            parseGitlabRetryAfterMs(new Headers({ 'retry-after': '12' }), now),
        ).toBe(12_000);
    });

    it('reads an HTTP date', () => {
        const date = new Date(now + 20_000).toUTCString();
        expect(
            parseGitlabRetryAfterMs(new Headers({ 'retry-after': date }), now),
        ).toBe(20_000);
    });

    it('falls back to RateLimit-Reset', () => {
        const reset = String((now + 15_000) / 1000);
        expect(
            parseGitlabRetryAfterMs(
                new Headers({ 'ratelimit-reset': reset }),
                now,
            ),
        ).toBe(15_000);
    });

    it('defaults to a minute without headers', () => {
        expect(parseGitlabRetryAfterMs(new Headers(), now)).toBe(
            GITLAB_DEFAULT_RETRY_AFTER_MS,
        );
    });

    it('caps an hour-long wait', () => {
        expect(
            parseGitlabRetryAfterMs(
                new Headers({ 'retry-after': '3600' }),
                now,
            ),
        ).toBe(GITLAB_MAX_RETRY_AFTER_MS);
    });
});
