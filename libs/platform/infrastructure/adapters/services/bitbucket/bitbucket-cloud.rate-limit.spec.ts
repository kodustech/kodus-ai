jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import {
    __resetRateGatesForTest,
    parkRateGate,
    rateGateKey,
    runWithRateGate,
} from '@libs/core/infrastructure/http/per-key-rate-gate';

import { BitbucketCloudService } from './bitbucket-cloud.service';

/**
 * A credential that keeps answering 429 used to park every queued call
 * behind fixed 10s waits with no limit: one review stage waited 99 minutes.
 * Now the wait doubles per 429 in a row and a call gives up with a 429
 * once its queue budget runs out.
 */

const AUTH = 'Basic dGVzdDp0ZXN0';
const gateKey = rateGateKey('bitbucket', AUTH);

function makeService() {
    const service = new BitbucketCloudService(
        { findOne: jest.fn() } as any,
        { createOrUpdateConfig: jest.fn() } as any,
        { findOne: jest.fn() } as any,
        { get: jest.fn() } as any,
    );
    const logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    (service as any).logger = logger;
    return { service, logger };
}

const respond = (status: number, headers: Record<string, string> = {}) =>
    new Response(status === 200 ? '{}' : '', {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });

const safeFetch = (service: BitbucketCloudService) =>
    (service as any).safeFetch('https://api.bitbucket.org/2.0/x', {
        headers: { authorization: AUTH },
    }) as Promise<Response>;

describe('BitbucketCloudService — 429 backoff and wait budget', () => {
    const realFetch = global.fetch;

    beforeEach(() => {
        __resetRateGatesForTest();
        jest.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        global.fetch = realFetch;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('doubles the wait between 429s without Retry-After', async () => {
        jest.useFakeTimers();
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(respond(429))
            .mockResolvedValueOnce(respond(429))
            .mockResolvedValueOnce(respond(200));
        global.fetch = fetchMock as any;
        const { service } = makeService();

        const result = safeFetch(service);

        await jest.advanceTimersByTimeAsync(9_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Second 429 in a row: 20s, not another 10s
        await jest.advanceTimersByTimeAsync(19_999);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(1);

        await expect(result).resolves.toMatchObject({ status: 200 });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('honours Retry-After over the backoff', async () => {
        jest.useFakeTimers();
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(respond(429, { 'retry-after': '2' }))
            .mockResolvedValueOnce(respond(200));
        global.fetch = fetchMock as any;
        const { service } = makeService();

        const result = safeFetch(service);
        await jest.advanceTimersByTimeAsync(2_000);

        await expect(result).resolves.toMatchObject({ status: 200 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(['0', ' '])(
        'feeds the doubling backoff instead of retrying at once on Retry-After %j',
        async (retryAfter) => {
            jest.useFakeTimers();
            const fetchMock = jest
                .fn()
                .mockResolvedValueOnce(
                    respond(429, { 'retry-after': retryAfter }),
                )
                .mockResolvedValueOnce(respond(429))
                .mockResolvedValueOnce(respond(200));
            global.fetch = fetchMock as any;
            const { service } = makeService();

            const result = safeFetch(service);
            await jest.advanceTimersByTimeAsync(9_999);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(1);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            // Second 429 in a row waits 20s: the header fed the backoff
            await jest.advanceTimersByTimeAsync(19_999);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            await jest.advanceTimersByTimeAsync(1);

            await expect(result).resolves.toMatchObject({ status: 200 });
            expect(fetchMock).toHaveBeenCalledTimes(3);
        },
    );

    it('answers 429 without calling Bitbucket once the wait budget is spent', async () => {
        const fetchMock = jest.fn().mockResolvedValue(respond(200));
        global.fetch = fetchMock as any;
        const { service, logger } = makeService();

        // A credential parked far beyond the 5 min budget
        await runWithRateGate(gateKey, { minIntervalMs: 0 }, async () => null);
        parkRateGate(gateKey, Date.now() + 30 * 60_000);

        const response = await safeFetch(service);

        // A 429 the SDK reads like Bitbucket's own: JSON error, seconds left
        expect(response.status).toBe(429);
        expect(response.statusText).toBe('Too Many Requests');
        expect(response.headers.get('content-type')).toBe('application/json');
        const retryAfter = Number(response.headers.get('retry-after'));
        expect(retryAfter).toBeGreaterThan(29 * 60);
        expect(retryAfter).toBeLessThanOrEqual(30 * 60);
        await expect(response.json()).resolves.toEqual({
            type: 'error',
            error: {
                message: expect.stringContaining('gave up after waiting'),
            },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringMatching(
                    /^Bitbucket rate gate: gave up after \d+ms waiting for a parked credential$/,
                ),
                metadata: expect.objectContaining({ gateKey }),
            }),
        );
    });

    it('lets any other fetch failure through as is, not as a 429', async () => {
        global.fetch = jest
            .fn()
            .mockRejectedValue(new TypeError('fetch failed')) as any;
        const { service } = makeService();

        await expect(safeFetch(service)).rejects.toThrow('fetch failed');
    });

    it('starts the backoff over after a response that was not a 429', async () => {
        jest.useFakeTimers();
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(respond(429))
            .mockResolvedValueOnce(respond(200))
            .mockResolvedValueOnce(respond(429))
            .mockResolvedValueOnce(respond(200));
        global.fetch = fetchMock as any;
        const { service } = makeService();

        const first = safeFetch(service);
        await jest.advanceTimersByTimeAsync(10_000);
        await expect(first).resolves.toMatchObject({ status: 200 });

        const second = safeFetch(service);
        // 10s again, not 20s: the success reset the streak
        await jest.advanceTimersByTimeAsync(10_500);
        await expect(second).resolves.toMatchObject({ status: 200 });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('honours a Retry-After given as an HTTP date', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-11-03T12:00:00Z'));
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(
                respond(429, {
                    'retry-after': 'Tue, 03 Nov 2026 12:00:03 GMT',
                }),
            )
            .mockResolvedValueOnce(respond(200));
        global.fetch = fetchMock as any;
        const { service } = makeService();

        const result = safeFetch(service);
        await jest.advanceTimersByTimeAsync(2_900);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(200);

        await expect(result).resolves.toMatchObject({ status: 200 });
    });

    it('falls back to the backoff for a Retry-After date that is now', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-11-03T12:00:00Z'));
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(
                respond(429, {
                    'retry-after': 'Tue, 03 Nov 2026 12:00:00 GMT',
                }),
            )
            .mockResolvedValueOnce(respond(200));
        global.fetch = fetchMock as any;
        const { service } = makeService();

        const result = safeFetch(service);
        await jest.advanceTimersByTimeAsync(9_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1_100);

        await expect(result).resolves.toMatchObject({ status: 200 });
    });

    it('falls back to the backoff for a Retry-After date already past', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-11-03T12:00:00Z'));
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(
                respond(429, {
                    'retry-after': 'Tue, 03 Nov 2026 11:00:00 GMT',
                }),
            )
            .mockResolvedValueOnce(respond(200));
        global.fetch = fetchMock as any;
        const { service } = makeService();

        const result = safeFetch(service);
        await jest.advanceTimersByTimeAsync(9_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1_100);

        await expect(result).resolves.toMatchObject({ status: 200 });
    });
});
