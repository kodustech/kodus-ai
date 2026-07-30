import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';
import { NotificationEvent } from '../domain/catalog/events';
import { NotificationRateLimiter } from './notification-rate-limiter.service';
import { NotificationService } from './notification.service';

/**
 * Rolling-window threshold for BYOK LLM errors before we notify the
 * organization's owners. Tuned to absorb transient blips while still
 * firing on genuine sustained failure (e.g. a revoked key, a quota
 * exhaustion, a misconfigured model).
 */
export const BYOK_ERROR_THRESHOLD = 5;
export const BYOK_ERROR_WINDOW_MS = 15 * 60 * 1000;
export const BYOK_ERROR_COOLDOWN_SECONDS = 60 * 60;

interface ByokErrorEntry {
    ts: number;
    provider: string;
    error: string;
}

@Injectable()
export class ByokErrorCounter {
    private readonly logger = createLogger(ByokErrorCounter.name);

    constructor(
        private readonly cache: CacheService,
        private readonly notifications: NotificationService,
        private readonly rateLimiter: NotificationRateLimiter,
    ) {}

    /**
     * Records a BYOK LLM error against the organization's rolling
     * window. When the count crosses the threshold and the per-org
     * cooldown is clear, emits `byok.llm_errors_threshold` to OWNER and
     * resets the bucket. Always resolves — never throws into the LLM
     * call site.
     */
    async record(input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }): Promise<void> {
        const { organizationId, provider, errorMessage } = input;
        // Internal-fallback errors (no org context) are operator concern,
        // not customer concern.
        if (!organizationId) return;

        try {
            const key = `byok:errors:${organizationId}`;
            const now = Date.now();
            const cutoff = now - BYOK_ERROR_WINDOW_MS;

            const existing =
                (await this.cache.getFromCache<ByokErrorEntry[]>(key)) ?? [];
            const pruned = existing.filter((e) => e.ts > cutoff);
            pruned.push({ ts: now, provider, error: errorMessage });

            if (pruned.length < BYOK_ERROR_THRESHOLD) {
                await this.cache.addToCache(key, pruned, BYOK_ERROR_WINDOW_MS);
                return;
            }

            // Clear the bucket regardless of whether we end up emitting,
            // so we don't re-trip on every subsequent error during the
            // cooldown.
            await this.cache.removeFromCache(key);

            const cooldownKey = `byok:errors:cooldown:${organizationId}`;
            const allowed = await this.rateLimiter.shouldEmit(
                cooldownKey,
                BYOK_ERROR_COOLDOWN_SECONDS,
            );
            if (!allowed) return;

            const windowStart = new Date(pruned[0]!.ts).toISOString();
            const windowEnd = new Date(now).toISOString();

            await this.notifications.emit({
                event: NotificationEvent.BYOK_LLM_ERRORS_THRESHOLD,
                organizationId,
                payload: {
                    provider,
                    errorCount: pruned.length,
                    windowStart,
                    windowEnd,
                    sampleError: errorMessage,
                },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'BYOK error counter failed — swallowing so LLM call site is unaffected',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                context: ByokErrorCounter.name,
                metadata: { organizationId, provider },
            });
        }
    }
}
