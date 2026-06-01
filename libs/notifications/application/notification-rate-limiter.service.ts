import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';

/**
 * Per-recipient rate limiter for notification emits.
 *
 * Used by call sites that want to bound how often a given user can be
 * notified about a given event (e.g. `review.skipped_no_license` is
 * capped at one per author per org per 24h, so a contributor opening 30
 * PRs during a license lapse gets one notification, not 30).
 *
 * Backing store is the shared {@link CacheService} (Redis when
 * configured, in-memory otherwise). There is a small race window
 * between GET and SET — two concurrent emits in the same millisecond
 * can both pass; for the use cases here that's an acceptable trade-off
 * vs. introducing a Redis SETNX wrapper.
 */
@Injectable()
export class NotificationRateLimiter {
    private readonly logger = createLogger(NotificationRateLimiter.name);

    constructor(private readonly cacheService: CacheService) {}

    /**
     * Returns true the first time `key` is seen within the TTL window,
     * false thereafter. Callers should use it as a guard:
     *
     * ```ts
     * if (!(await rateLimiter.shouldEmit(key, 24 * 60 * 60))) return;
     * await notificationService.emit({ ... });
     * ```
     *
     * `ttlSeconds` is converted to the milliseconds the cache layer
     * expects.
     */
    async shouldEmit(key: string, ttlSeconds: number): Promise<boolean> {
        try {
            const existing = await this.cacheService.getFromCache<true>(key);
            if (existing) return false;
            await this.cacheService.addToCache(key, true, ttlSeconds * 1000);
            return true;
        } catch (error) {
            // Fail open: if the cache is down, we'd rather emit a
            // duplicate notification than swallow it silently.
            this.logger.error({
                message:
                    'Rate limiter cache lookup failed — allowing emit (fail-open)',
                error: error instanceof Error ? error : new Error(String(error)),
                context: NotificationRateLimiter.name,
                metadata: { key },
            });
            return true;
        }
    }
}
