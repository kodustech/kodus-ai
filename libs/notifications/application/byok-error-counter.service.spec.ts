import { CacheService } from '@libs/core/cache/cache.service';
import {
    ByokErrorCounter,
    BYOK_ERROR_THRESHOLD,
    BYOK_ERROR_WINDOW_MS,
    BYOK_ERROR_COOLDOWN_SECONDS,
} from './byok-error-counter.service';
import { NotificationEvent } from '../domain/catalog/events';
import { NotificationRateLimiter } from './notification-rate-limiter.service';
import { NotificationService } from './notification.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('ByokErrorCounter', () => {
    let cache: jest.Mocked<
        Pick<CacheService, 'getFromCache' | 'addToCache' | 'removeFromCache'>
    >;
    let notifications: jest.Mocked<Pick<NotificationService, 'emit'>>;
    let rateLimiter: jest.Mocked<Pick<NotificationRateLimiter, 'shouldEmit'>>;
    let counter: ByokErrorCounter;

    const ORG = 'org-uuid-1';
    const PROVIDER = 'anthropic';
    const ERROR = 'overloaded_error: too many concurrent requests';
    const NOW = new Date('2026-05-12T12:00:00Z').getTime();

    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(NOW);
        cache = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn().mockResolvedValue(undefined),
            removeFromCache: jest.fn().mockResolvedValue(undefined),
        };
        notifications = { emit: jest.fn().mockResolvedValue(undefined) };
        rateLimiter = { shouldEmit: jest.fn().mockResolvedValue(true) };
        counter = new ByokErrorCounter(
            cache as unknown as CacheService,
            notifications as unknown as NotificationService,
            rateLimiter as unknown as NotificationRateLimiter,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('no-ops when organizationId is missing — internal fallback errors are our problem, not the customer-s', async () => {
        await counter.record({
            organizationId: undefined,
            provider: PROVIDER,
            errorMessage: ERROR,
        });
        expect(cache.addToCache).not.toHaveBeenCalled();
        expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('appends the current timestamp to the rolling list and persists with the window TTL', async () => {
        cache.getFromCache.mockResolvedValueOnce(null);

        await counter.record({
            organizationId: ORG,
            provider: PROVIDER,
            errorMessage: ERROR,
        });

        expect(cache.addToCache).toHaveBeenCalledWith(
            `byok:errors:${ORG}`,
            // First entry — list of {ts, provider, error}
            expect.arrayContaining([
                expect.objectContaining({ ts: NOW, provider: PROVIDER }),
            ]),
            BYOK_ERROR_WINDOW_MS,
        );
        expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('drops entries older than the window when appending', async () => {
        const expired = NOW - BYOK_ERROR_WINDOW_MS - 1000;
        const fresh = NOW - 5_000;
        cache.getFromCache.mockResolvedValueOnce([
            { ts: expired, provider: 'openai', error: 'old' },
            { ts: fresh, provider: PROVIDER, error: 'recent' },
        ]);

        await counter.record({
            organizationId: ORG,
            provider: PROVIDER,
            errorMessage: ERROR,
        });

        const written = cache.addToCache.mock.calls[0]![1] as Array<{
            ts: number;
        }>;
        expect(written.map((e) => e.ts)).toEqual([fresh, NOW]);
    });

    it('does not emit while count is below threshold', async () => {
        const existing = Array.from(
            { length: BYOK_ERROR_THRESHOLD - 2 },
            () => ({
                ts: NOW - 1_000,
                provider: PROVIDER,
                error: ERROR,
            }),
        );
        cache.getFromCache.mockResolvedValueOnce(existing);

        await counter.record({
            organizationId: ORG,
            provider: PROVIDER,
            errorMessage: ERROR,
        });

        expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('emits BYOK_LLM_ERRORS_THRESHOLD to OWNER once threshold is reached', async () => {
        const existing = Array.from(
            { length: BYOK_ERROR_THRESHOLD - 1 },
            () => ({
                ts: NOW - 1_000,
                provider: PROVIDER,
                error: 'earlier',
            }),
        );
        cache.getFromCache.mockResolvedValueOnce(existing);

        await counter.record({
            organizationId: ORG,
            provider: PROVIDER,
            errorMessage: ERROR,
        });

        expect(rateLimiter.shouldEmit).toHaveBeenCalledWith(
            `byok:errors:cooldown:${ORG}`,
            BYOK_ERROR_COOLDOWN_SECONDS,
        );
        expect(notifications.emit).toHaveBeenCalledTimes(1);
        const emitArg = notifications.emit.mock.calls[0]![0];
        expect(emitArg.event).toBe(NotificationEvent.BYOK_LLM_ERRORS_THRESHOLD);
        expect(emitArg.organizationId).toBe(ORG);
        expect(emitArg.payload).toEqual(
            expect.objectContaining({
                provider: PROVIDER,
                errorCount: BYOK_ERROR_THRESHOLD,
                sampleError: ERROR,
                windowStart: expect.any(String),
                windowEnd: expect.any(String),
            }),
        );
        expect(emitArg.recipients).toBeUndefined();
    });

    it('resets the rolling list after firing so a second emit needs a fresh batch', async () => {
        const existing = Array.from(
            { length: BYOK_ERROR_THRESHOLD - 1 },
            () => ({
                ts: NOW - 1_000,
                provider: PROVIDER,
                error: 'earlier',
            }),
        );
        cache.getFromCache.mockResolvedValueOnce(existing);

        await counter.record({
            organizationId: ORG,
            provider: PROVIDER,
            errorMessage: ERROR,
        });

        expect(cache.removeFromCache).toHaveBeenCalledWith(
            `byok:errors:${ORG}`,
        );
    });

    it('skips the emit when cooldown is still active', async () => {
        const existing = Array.from(
            { length: BYOK_ERROR_THRESHOLD - 1 },
            () => ({
                ts: NOW - 1_000,
                provider: PROVIDER,
                error: 'earlier',
            }),
        );
        cache.getFromCache.mockResolvedValueOnce(existing);
        rateLimiter.shouldEmit.mockResolvedValueOnce(false);

        await counter.record({
            organizationId: ORG,
            provider: PROVIDER,
            errorMessage: ERROR,
        });

        expect(notifications.emit).not.toHaveBeenCalled();
        // We still clear the bucket so we don-t re-emit on every error
        // for the rest of the cooldown window.
        expect(cache.removeFromCache).toHaveBeenCalledWith(
            `byok:errors:${ORG}`,
        );
    });

    it('never throws — cache failures must not surface to LLM call sites', async () => {
        cache.getFromCache.mockRejectedValueOnce(new Error('redis down'));

        await expect(
            counter.record({
                organizationId: ORG,
                provider: PROVIDER,
                errorMessage: ERROR,
            }),
        ).resolves.toBeUndefined();
    });

    it('never throws — emit failures must not surface to LLM call sites', async () => {
        const existing = Array.from(
            { length: BYOK_ERROR_THRESHOLD - 1 },
            () => ({
                ts: NOW - 1_000,
                provider: PROVIDER,
                error: 'earlier',
            }),
        );
        cache.getFromCache.mockResolvedValueOnce(existing);
        notifications.emit.mockRejectedValueOnce(new Error('broker down'));

        await expect(
            counter.record({
                organizationId: ORG,
                provider: PROVIDER,
                errorMessage: ERROR,
            }),
        ).resolves.toBeUndefined();
    });
});
