import { createLogger } from '@libs/core/log/logger';

import { currentActivity } from './activity-registry';

const logger = createLogger('SlowSync');

/**
 * Synchronous work at or above this holds the event loop long enough to
 * matter: every job on the worker waits, and the health check starts to
 * miss. Far below the 20s the stall watchdog reports, so a slow input shows
 * up here before it ever freezes a worker.
 */
export const SLOW_SYNC_MS = 1_000;

/**
 * Runs `fn` (synchronous) and, when it held the event loop SLOW_SYNC_MS or
 * more, logs which work it was, how big its input was and which job it ran
 * for. Costs two clock reads otherwise; never changes `fn`'s result or error.
 */
export function timeSync<T>(
    label: string,
    fn: () => T,
    meta?: () => Record<string, unknown>,
): T {
    const started = performance.now();
    try {
        return fn();
    } finally {
        const ms = performance.now() - started;
        if (ms >= SLOW_SYNC_MS) {
            try {
                logger.warn({
                    message: `[SLOW-SYNC] ${label} held the event loop ${Math.round(ms)}ms`,
                    context: 'SlowSync',
                    metadata: {
                        label,
                        durationMs: Math.round(ms),
                        ...(meta?.() ?? {}),
                        job: currentActivity(),
                    },
                });
            } catch {
                // observability must never break the work it measures
            }
        }
    }
}
