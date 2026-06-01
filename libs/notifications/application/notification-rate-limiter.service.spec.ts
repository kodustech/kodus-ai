import { CacheService } from '@libs/core/cache/cache.service';
import { NotificationRateLimiter } from './notification-rate-limiter.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('NotificationRateLimiter', () => {
    let cache: jest.Mocked<Pick<CacheService, 'getFromCache' | 'addToCache'>>;
    let limiter: NotificationRateLimiter;

    beforeEach(() => {
        cache = {
            getFromCache: jest.fn(),
            addToCache: jest.fn().mockResolvedValue(undefined),
        };
        limiter = new NotificationRateLimiter(cache as unknown as CacheService);
    });

    it('returns true on first call and sets the key with the requested TTL', async () => {
        cache.getFromCache.mockResolvedValueOnce(null);

        const allowed = await limiter.shouldEmit('notif:foo', 600);

        expect(allowed).toBe(true);
        expect(cache.getFromCache).toHaveBeenCalledWith('notif:foo');
        // TTL on the cache layer is milliseconds; service multiplies by 1000.
        expect(cache.addToCache).toHaveBeenCalledWith(
            'notif:foo',
            true,
            600_000,
        );
    });

    it('returns false when the key is already present and does not re-set it', async () => {
        cache.getFromCache.mockResolvedValueOnce(true);

        const allowed = await limiter.shouldEmit('notif:foo', 600);

        expect(allowed).toBe(false);
        expect(cache.addToCache).not.toHaveBeenCalled();
    });

    it('fails open: returns true when the cache get throws', async () => {
        cache.getFromCache.mockRejectedValueOnce(new Error('redis down'));

        const allowed = await limiter.shouldEmit('notif:foo', 600);

        expect(allowed).toBe(true);
        // Did not attempt to write either — fail-open means "treat as
        // first call without polluting state".
        expect(cache.addToCache).not.toHaveBeenCalled();
    });

    it('fails open: returns true when the cache set throws', async () => {
        cache.getFromCache.mockResolvedValueOnce(null);
        cache.addToCache.mockRejectedValueOnce(new Error('redis dead'));

        const allowed = await limiter.shouldEmit('notif:bar', 1);

        expect(allowed).toBe(true);
    });
});
