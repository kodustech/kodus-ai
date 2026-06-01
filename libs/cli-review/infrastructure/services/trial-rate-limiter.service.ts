import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { CacheService } from '@libs/core/cache/cache.service';
import {
    ITrialRateLimiterService,
    RateLimitResult,
} from '@libs/cli-review/domain/contracts/trial-rate-limiter.service.contract';

// Re-export so existing importers of the result type from this module
// keep working after it moved to the domain contract.
export type { RateLimitResult };

/**
 * Service for rate limiting trial CLI reviews
 * Uses cache to track request counts per fingerprint
 */
@Injectable()
export class TrialRateLimiterService implements ITrialRateLimiterService {
    private readonly logger = createLogger(TrialRateLimiterService.name);
    private readonly RATE_LIMIT = 2; // 2 requests per window (trial users)
    private readonly WINDOW_MS = 60 * 60 * 1000; // 1 hour
    private readonly FALLBACK_LIMIT = 1; // More restrictive limit when cache fails

    // In-memory fallback for when cache fails
    private fallbackStore: Map<string, number[]> = new Map();
    private lastCleanup: number = Date.now();
    private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // Cleanup every 5 minutes

    constructor(private readonly cacheService: CacheService) {}

    async checkRateLimit(fingerprint: string): Promise<RateLimitResult> {
        const key = `cli:trial:ratelimit:${fingerprint}`;
        const now = Date.now();
        const windowStart = now - this.WINDOW_MS;

        try {
            // Get current request timestamps
            const timestampsData = await this.cacheService.getFromCache<{
                timestamps: number[];
            }>(key);

            let timestamps = timestampsData?.timestamps || [];

            // Filter out old timestamps outside the window
            timestamps = timestamps.filter((ts) => ts > windowStart);

            // Add current request
            timestamps.push(now);

            // Store updated timestamps
            await this.cacheService.addToCache(
                key,
                { timestamps },
                this.WINDOW_MS,
            );

            const count = timestamps.length;
            const allowed = count <= this.RATE_LIMIT;
            const remaining = Math.max(0, this.RATE_LIMIT - count);

            // Calculate reset time (oldest timestamp + window duration)
            const oldestTimestamp = timestamps[0];
            const resetAt = oldestTimestamp
                ? new Date(oldestTimestamp + this.WINDOW_MS)
                : new Date(now + this.WINDOW_MS);

            if (!allowed) {
                this.logger.warn({
                    message: 'Rate limit exceeded for trial user',
                    context: TrialRateLimiterService.name,
                    metadata: {
                        fingerprint,
                        count,
                        limit: this.RATE_LIMIT,
                        resetAt: resetAt.toISOString(),
                    },
                });
            }

            return {
                allowed,
                remaining,
                resetAt,
            };
        } catch (error) {
            this.logger.error({
                message: 'Cache error, using in-memory fallback',
                error,
                context: TrialRateLimiterService.name,
                metadata: { fingerprint },
            });

            // Use in-memory fallback with more restrictive limit
            return this.checkRateLimitFallback(fingerprint);
        }
    }

    /**
     * In-memory fallback rate limiter with more restrictive limits
     * Used when cache is unavailable
     */
    private checkRateLimitFallback(fingerprint: string): RateLimitResult {
        const now = Date.now();
        const windowStart = now - this.WINDOW_MS;

        // Periodic cleanup to prevent memory leak
        if (now - this.lastCleanup > this.CLEANUP_INTERVAL) {
            this.cleanupFallbackStore(windowStart);
            this.lastCleanup = now;
        }

        // Get or create timestamps array
        let timestamps = this.fallbackStore.get(fingerprint) || [];

        // Filter out old timestamps
        timestamps = timestamps.filter((ts) => ts > windowStart);

        // Add current request
        timestamps.push(now);
        this.fallbackStore.set(fingerprint, timestamps);

        const count = timestamps.length;
        const allowed = count <= this.FALLBACK_LIMIT;
        const remaining = Math.max(0, this.FALLBACK_LIMIT - count);

        const oldestTimestamp = timestamps[0];
        const resetAt = oldestTimestamp
            ? new Date(oldestTimestamp + this.WINDOW_MS)
            : new Date(now + this.WINDOW_MS);

        if (!allowed) {
            this.logger.warn({
                message: 'Fallback rate limit exceeded',
                context: TrialRateLimiterService.name,
                metadata: {
                    fingerprint,
                    count,
                    limit: this.FALLBACK_LIMIT,
                },
            });
        }

        return {
            allowed,
            remaining,
            resetAt,
        };
    }

    /**
     * Cleanup old entries from fallback store
     */
    private cleanupFallbackStore(windowStart: number): void {
        for (const [fingerprint, timestamps] of this.fallbackStore.entries()) {
            const validTimestamps = timestamps.filter((ts) => ts > windowStart);
            if (validTimestamps.length === 0) {
                this.fallbackStore.delete(fingerprint);
            } else {
                this.fallbackStore.set(fingerprint, validTimestamps);
            }
        }
    }

    /**
     * Get current rate limit status without incrementing
     */
    async getRateLimitStatus(fingerprint: string): Promise<RateLimitResult> {
        const key = `cli:trial:ratelimit:${fingerprint}`;
        const now = Date.now();
        const windowStart = now - this.WINDOW_MS;

        try {
            const timestampsData = await this.cacheService.getFromCache<{
                timestamps: number[];
            }>(key);

            let timestamps = timestampsData?.timestamps || [];
            timestamps = timestamps.filter((ts) => ts > windowStart);

            const count = timestamps.length;
            const allowed = count < this.RATE_LIMIT;
            const remaining = Math.max(0, this.RATE_LIMIT - count);

            const oldestTimestamp = timestamps[0];
            const resetAt = oldestTimestamp
                ? new Date(oldestTimestamp + this.WINDOW_MS)
                : undefined;

            return {
                allowed,
                remaining,
                resetAt,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting rate limit status',
                error,
                context: TrialRateLimiterService.name,
                metadata: { fingerprint },
            });

            return {
                allowed: true,
                remaining: this.RATE_LIMIT,
            };
        }
    }
}
