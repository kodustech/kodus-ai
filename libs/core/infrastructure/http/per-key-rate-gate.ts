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
    /** 429s in a row on this key; drives the backoff when Retry-After is absent. */
    rateLimitStreak: number;
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
    /**
     * Longest a call may wait for its turn before the gate gives up with
     * {@link RateGateWaitExceededError}: a park it would sleep past the
     * budget, or, while the key is in a 429 streak, any wait (queue
     * included) past it. Without it a credential that keeps answering 429
     * parks every queued caller indefinitely: one review stage waited 99
     * minutes this way. Unset means no limit.
     */
    maxWaitMs?: number;
}

/**
 * Thrown by {@link runWithRateGate} when a call would wait longer than
 * `maxWaitMs`. Carries `status: 429` so `is429Error` and provider error
 * handling treat it as the rate limit it is.
 */
export class RateGateWaitExceededError extends Error {
    readonly status = 429;

    constructor(
        readonly key: string,
        readonly waitedMs: number,
        /** How long until the gate expects to admit calls again. */
        readonly retryAfterMs: number,
    ) {
        super(
            `Rate gate ${key}: gave up after waiting ${waitedMs}ms (key parked for another ${retryAfterMs}ms)`,
        );
        this.name = 'RateGateWaitExceededError';
    }
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
            rateLimitStreak: 0,
        };
        gates.set(key, gate);
    }
    return gate;
}

/**
 * Runs `fn` under the gate for `key`. Acquires the single slot, waits
 * out any active park window and the min-interval spacing, then runs.
 * With `maxWaitMs`, rejects instead of waiting past that budget; a
 * rejected call frees the slot at once, so a parked queue drains fast.
 */
export async function runWithRateGate<T>(
    key: string,
    options: RateGateOptions,
    fn: () => Promise<T>,
): Promise<T> {
    const concurrency = options.concurrency ?? 1;
    const gate = getGate(key, concurrency);
    const enqueuedAt = Date.now();
    const deadline =
        options.maxWaitMs === undefined
            ? Infinity
            : enqueuedAt + options.maxWaitMs;

    // The checks below run only once the slot is ours. A call queued behind
    // one that holds the slot through its own 429 retries would otherwise
    // wait for all of them, so the budget also runs while queued.
    let admitted = false;
    let expired = false;
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectQueued: (error: Error) => void = () => {};
    const queuedExpiry = new Promise<never>((_, reject) => {
        rejectQueued = reject;
    });
    if (deadline !== Infinity) {
        const checkQueued = () => {
            if (admitted) return;
            if (gate.rateLimitStreak > 0) {
                expired = true;
                const now = Date.now();
                rejectQueued(
                    new RateGateWaitExceededError(
                        key,
                        now - enqueuedAt,
                        Math.max(
                            0,
                            Math.max(gate.pausedUntil, gate.nextAllowedAt) -
                                now,
                        ),
                    ),
                );
                return;
            }
            // A healthy queue is never cut short; look again shortly.
            admissionTimer = setTimeout(checkQueued, 1_000);
        };
        admissionTimer = setTimeout(checkQueued, options.maxWaitMs);
    }

    const run = gate.limit(async (): Promise<T | undefined> => {
        // Expired while queued: the caller already has its 429.
        if (expired) return undefined;
        admitted = true;
        clearTimeout(admissionTimer);
        // Park + spacing can both move while we sleep (a sibling call
        // that 429'd may extend pausedUntil), so re-check in a loop.
        for (;;) {
            const now = Date.now();
            const waitUntil = Math.max(gate.pausedUntil, gate.nextAllowedAt);
            // While the key is rate limited, time spent queued behind other
            // calls counts too: each of them may hold the slot through its
            // own 429 retries, so a deep queue would otherwise wait without
            // bound. A healthy queue (spacing only) is never cut short.
            if (gate.rateLimitStreak > 0 && now > deadline) {
                throw new RateGateWaitExceededError(
                    key,
                    now - enqueuedAt,
                    Math.max(0, waitUntil - now),
                );
            }
            if (waitUntil <= now) break;
            if (waitUntil > deadline) {
                throw new RateGateWaitExceededError(
                    key,
                    now - enqueuedAt,
                    waitUntil - now,
                );
            }
            await sleep(waitUntil - now);
        }
        // Reserve the next slot *before* the call so the following caller
        // spaces off this call's start, not its (variable) completion.
        gate.nextAllowedAt = Date.now() + options.minIntervalMs;
        return fn();
    });

    return Promise.race([run as Promise<T>, queuedExpiry]).finally(() =>
        clearTimeout(admissionTimer),
    );
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

export interface RateLimitBackoffOptions {
    /** Delay after the first 429 in a row. */
    baseMs: number;
    /** Ceiling for the doubling delay. */
    maxMs: number;
}

/**
 * Records a 429 on `key` and returns how long to back off when the
 * upstream gave no Retry-After: `baseMs` doubled for each 429 in a row,
 * capped at `maxMs`, with up to 20% jitter so processes sharing a
 * credential do not retry in lockstep. A fixed delay re-hits a limit that
 * is still closed; doubling backs off until the window really opens.
 */
export function recordRateLimited(
    key: string,
    backoff: RateLimitBackoffOptions,
): number {
    const gate = getGate(key, 1);
    gate.rateLimitStreak += 1;
    const doubled = backoff.baseMs * 2 ** (gate.rateLimitStreak - 1);
    const delay = Math.min(doubled, backoff.maxMs);
    return Math.round(delay * (1 + Math.random() * 0.2));
}

/** Resets the 429 streak on `key` after a response that was not a 429. */
export function recordRateGateSuccess(key: string): void {
    const gate = gates.get(key);
    if (gate) gate.rateLimitStreak = 0;
}

/** Test-only: drop all gate state so cases don't leak spacing into each other. */
export function __resetRateGatesForTest(): void {
    gates.clear();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
