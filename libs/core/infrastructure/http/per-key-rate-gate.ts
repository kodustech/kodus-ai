/**
 * Per-key rate gate for provider API calls that share ONE upstream
 * credential and a tight server-side rate limit (Bitbucket Cloud's
 * per-app-password budget being the motivating case: ~1000 req/hour
 * plus short per-endpoint burst windows of 16-60 req/min).
 *
 * `with429Retry` (sibling file) is purely *reactive*: it only acts
 * after the upstream already answered 429. Under real onboarding load
 * the historical-PR backfill, the live review pipeline and the dashboard
 * polling all fire against the same token at once; they all 429, all
 * back off with jitter, and re-collide. Reactive retry never *prevents*
 * the burst — it just smears it.
 *
 * This gate is *proactive*: every call for a given key flows through a
 * single-slot queue (so concurrent callers serialize instead of
 * bursting) with a minimum interval between call starts. On a 429 the
 * caller parks the whole key until the Retry-After window clears, so
 * sibling calls wait instead of piling on. It composes with
 * `with429Retry`: the retry's next attempt re-enters the gate and blocks
 * on the park window.
 *
 * Scope: in-memory, per-process. The app runs API / worker / webhooks as
 * separate processes, so a given key is gated independently in each. That
 * is deliberate and sufficient — the dominant burst source (the backfill
 * loop, which fans out over repos via `Promise.all`) lives entirely in
 * the API process, so serializing it there tames it; the small residual
 * cross-process overlap is absorbed by `with429Retry`. A distributed
 * limiter would mean adding Redis to every topology (cloud and
 * self-hosted alike), which the deployment intentionally avoids.
 */

import pLimit from 'p-limit';
import { createHash } from 'crypto';

interface GateState {
    /** Single-slot limiter: serializes all calls sharing this key. */
    readonly limit: ReturnType<typeof pLimit>;
    /** Epoch ms before which the next call must not *start* (spacing). */
    nextAllowedAt: number;
    /** Epoch ms until which the key is parked after a 429 (Retry-After). */
    pausedUntil: number;
}

const gates = new Map<string, GateState>();

export interface RateGateOptions {
    /** Minimum interval (ms) between the *starts* of two gated calls. */
    minIntervalMs: number;
    /**
     * Concurrent slots for this key. Defaults to 1 (full serialization),
     * which is the safe choice for a single shared credential.
     */
    concurrency?: number;
}

/**
 * Derives a stable, non-reversible gate key from a raw secret-bearing
 * string (e.g. an `Authorization` header). Hashing keeps the live
 * credential out of the in-memory map and any log line that echoes a
 * key, while still bucketing every call for the same credential
 * together.
 */
export function rateGateKey(prefix: string, raw: string): string {
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return `${prefix}:${digest}`;
}

function getGate(key: string, concurrency: number): GateState {
    let gate = gates.get(key);
    if (!gate) {
        gate = {
            limit: pLimit(concurrency),
            nextAllowedAt: 0,
            pausedUntil: 0,
        };
        gates.set(key, gate);
    }
    return gate;
}

/**
 * Runs `fn` under the gate for `key`. Acquires the single slot, waits
 * out any active park window and the min-interval spacing, then runs.
 */
export async function runWithRateGate<T>(
    key: string,
    options: RateGateOptions,
    fn: () => Promise<T>,
): Promise<T> {
    const concurrency = options.concurrency ?? 1;
    const gate = getGate(key, concurrency);

    return gate.limit(async () => {
        // Park + spacing can both move while we sleep (a sibling call
        // that 429'd may extend pausedUntil), so re-check in a loop.
        for (;;) {
            const now = Date.now();
            const waitUntil = Math.max(gate.pausedUntil, gate.nextAllowedAt);
            if (waitUntil <= now) break;
            await sleep(waitUntil - now);
        }
        // Reserve the next slot *before* the call so the following caller
        // spaces off this call's start, not its (variable) completion.
        gate.nextAllowedAt = Date.now() + options.minIntervalMs;
        return fn();
    });
}

/**
 * Parks `key` until at least `untilEpochMs`. Idempotent under contention:
 * only ever extends the window, never shortens it. Call this when an
 * upstream 429 carries a Retry-After hint.
 */
export function parkRateGate(key: string, untilEpochMs: number): void {
    const gate = gates.get(key);
    if (gate) {
        gate.pausedUntil = Math.max(gate.pausedUntil, untilEpochMs);
    }
}

/** Test-only: drop all gate state so cases don't leak spacing into each other. */
export function __resetRateGatesForTest(): void {
    gates.clear();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
