/**
 * BYOK concurrency / rate / token-reservoir limiter (Wave 2 extraction).
 *
 * Moved VERBATIM out of byok-to-vercel.ts: the `BYOKConcurrencyLimiter` class,
 * its module-scoped cache, and the `runWithBYOKLimiter` / `getLimiterForSlot`
 * seams. Keyed on ONE resolved slot (a `NormalizedModel`). No dependency on the
 * model-builder path — the limiter only needs the slot's identity/throttle
 * fields plus the canonical logger.
 */
import type { NormalizedModel } from '@libs/llm/byok-config';
import { createLogger } from '@libs/core/log/logger';

type QueuedTask<T> = {
    id: number;
    label: string;
    run: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
    started: boolean;
    cancelled: boolean;
    timer?: ReturnType<typeof setTimeout>;
    cleanup?: () => void;
    // tpm reservoir accounting (both undefined ⇒ no token gate for this task).
    // `estimatedTokens` is the PRE-call tiktoken estimate that debits the
    // reservoir at admission; `getUsageTokens` extracts the POST-call real total
    // from the task result so the reservoir reconciles the estimate against
    // actual usage after the call resolves.
    estimatedTokens?: number;
    getUsageTokens?: (result: T) => number | undefined;
};

const DEFAULT_LIMITER_QUEUE_TIMEOUT_MS = 0;

// O3: lightweight, low-cardinality observability for the reliability limiter so
// throttle/cooldown/queue-timeout are visible (not silently indistinguishable
// from latency). Uses the repo's canonical createLogger — NO dependency on
// observability.service.ts. Signals carry {provider, model, reason, waitMs}
// ONLY — never a key or ciphertext.
const limiterLogger = createLogger('BYOKConcurrencyLimiter');

export class BYOKConcurrencyLimiter {
    private readonly queue: Array<QueuedTask<unknown>> = [];
    private activeCount = 0;
    private nextTaskId = 1;

    // rpm rate gate: min-interval (ms) between two actual task STARTS. 0 ⇒
    // disabled (concurrency-only, today's behavior). `lastStartAt` seeds to
    // -Infinity so the very first task starts immediately. `rateTimer` holds the
    // single pending re-drain scheduled while the rate window is closed.
    private concurrency: number;
    private minInterval = 0;
    private lastStartAt = Number.NEGATIVE_INFINITY;
    private rateTimer?: ReturnType<typeof setTimeout>;

    // tpm token reservoir: `tpmCapacity` (tokens/min) is the bucket size and the
    // per-minute refill rate; 0 ⇒ disabled (concurrency/rpm only). `reservoir`
    // holds the current available tokens (may go NEGATIVE when a single request's
    // real usage overshoots its estimate — reconcile debits the overshoot).
    // `reservoirRefillAt` timestamps the last linear refill. `tpmTimer` holds the
    // single pending re-drain scheduled while the reservoir is too low to admit
    // the head task (DELAY, never retry — mirrors the rpm rateTimer).
    private tpmCapacity = 0;
    private reservoir = 0;
    private reservoirRefillAt = 0;
    private tpmTimer?: ReturnType<typeof setTimeout>;

    // cooldown gate (429-armed): absolute timestamp until which NO new task may
    // start. 0 ⇒ never armed. `armCooldown(ms)` (called by the wrapper catch on a
    // classified RATE_LIMIT) pushes it to `Date.now() + ms`; drain() DELAYS every
    // admission while `Date.now() < cooldownUntil` (never a retry — a delay).
    // `cooldownTimer` holds the single pending re-drain scheduled at expiry so a
    // cooldown-only slot (Infinity concurrency, no rpm/tpm) still resumes.
    private cooldownUntil = 0;
    private cooldownTimer?: ReturnType<typeof setTimeout>;

    // O3: low-cardinality identity for observability signals. NOT secret
    // (provider enum + model id); the ciphertext apiKey is NEVER stored here.
    private readonly provider: string;
    private readonly model: string;

    constructor(
        concurrency: number,
        rpm?: number,
        tpm?: number,
        provider = 'unknown',
        model = 'unknown',
    ) {
        this.concurrency = concurrency;
        this.provider = provider;
        this.model = model;
        this.setRpm(rpm);
        this.setTpm(tpm);
    }

    /**
     * O3: emit a lightweight structured throttle/cooldown/queue signal. Fields
     * are provider + model + reason + waitMs ONLY — never a key or ciphertext.
     * A debug log is intentionally cheap; it makes the reliability gates
     * observable without a dependency on observability.service.ts.
     */
    private emitThrottleSignal(reason: string, waitMs: number): void {
        limiterLogger.debug({
            message: `[BYOK-LIMITER] ${reason}`,
            context: 'BYOKConcurrencyLimiter',
            metadata: {
                provider: this.provider,
                model: this.model,
                reason,
                waitMs: Math.max(0, Math.round(waitMs)),
            },
        });
    }

    /** Current concurrency ceiling (read by runWithBYOKLimiter for cache reuse). */
    getConcurrency(): number {
        return this.concurrency;
    }

    /**
     * Arm the cooldown gate for `ms` from now (called by the wrapper catch on a
     * classified RATE_LIMIT). Extends — never shortens — an active window, so
     * overlapping 429s don't cut a cooldown short. Non-finite/≤0 is ignored
     * (cooldownMs disabled ⇒ never arms). Schedules ONE re-drain at expiry so a
     * cooldown-only slot resumes without an external tick. Arming is a DELAY, not
     * a retry: it holds admissions; it never re-invokes any task.
     */
    armCooldown(ms: number): void {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return;
        const until = Date.now() + ms;
        if (until <= this.cooldownUntil) return; // never shorten an active window
        this.cooldownUntil = until;
        if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
        this.cooldownTimer = setTimeout(() => {
            this.cooldownTimer = undefined;
            this.drain();
        }, this.cooldownUntil - Date.now());
        this.emitThrottleSignal('cooldown-arm', ms);
    }

    /**
     * P2: true when this limiter has NO queued or in-flight work and NO pending
     * rate/reservoir/cooldown timer — i.e. it is safe to evict from the module
     * limiter cache. A limiter with live work or a scheduled re-drain is NEVER
     * idle (evicting it would drop its queue/timers and stall those tasks).
     */
    isIdle(): boolean {
        return (
            this.queue.length === 0 &&
            this.activeCount === 0 &&
            !this.rateTimer &&
            !this.tpmTimer &&
            !this.cooldownTimer
        );
    }

    /** True while the cooldown window is still in the future. The retry owner
     *  (structured-review-call) consults this to skip re-issuing into a cooling
     *  slot. Reads no key material. */
    isInCooldown(): boolean {
        return this.cooldownUntil > Date.now();
    }

    /**
     * Re-tune a LIVE limiter without discarding its queue or in-flight rate
     * state (Pitfall 4). An unrelated config edit keyed on the same identity
     * fields updates the ceiling/interval on the cached instance rather than
     * constructing a new one that would reset `lastStartAt`.
     */
    configure(opts: {
        concurrency?: number;
        rpm?: number;
        tpm?: number;
    }): void {
        if (typeof opts.concurrency === 'number') {
            this.concurrency = opts.concurrency;
        }
        if ('rpm' in opts) {
            this.setRpm(opts.rpm);
        }
        if ('tpm' in opts) {
            this.setTpm(opts.tpm);
        }
        // A widened ceiling / disabled rate gate may unblock queued tasks.
        this.drain();
    }

    /** Compute the min-interval from rpm; guards against non-finite/≤0 → disabled. */
    private setRpm(rpm?: number): void {
        this.minInterval =
            typeof rpm === 'number' && Number.isFinite(rpm) && rpm > 0
                ? 60_000 / rpm
                : 0;
    }

    /**
     * Set/re-tune the token reservoir capacity. Guards non-finite/≤0 → disabled.
     * FIRST enable seeds the reservoir FULL (so an idle slot admits immediately).
     * A re-tune (config edit on a LIVE limiter) keeps the current balance —
     * capped at the new capacity — so an unrelated edit never refills a
     * mid-throttle reservoir (Pitfall 4). tpm is NOT a limiter identity field;
     * `buildLimiterCacheKey` is unchanged, so this re-tunes the cached instance.
     */
    private setTpm(tpm?: number): void {
        const capacity =
            typeof tpm === 'number' && Number.isFinite(tpm) && tpm > 0 ? tpm : 0;
        if (capacity === 0) {
            this.tpmCapacity = 0;
            return;
        }
        const wasDisabled = this.tpmCapacity === 0;
        this.tpmCapacity = capacity;
        if (wasDisabled) {
            // Seed FULL on first enable so an idle slot is not throttled.
            this.reservoir = capacity;
            this.reservoirRefillAt = Date.now();
        } else {
            // Re-tune: preserve the in-flight balance, capped at new capacity.
            this.reservoir = Math.min(this.reservoir, capacity);
        }
    }

    /** Linearly refill the reservoir (tokens += capacity * elapsedMs / 60000),
     *  capped at capacity. No-op when tpm is disabled. */
    private refillReservoir(): void {
        if (this.tpmCapacity <= 0) return;
        const now = Date.now();
        const elapsed = now - this.reservoirRefillAt;
        if (elapsed <= 0) return;
        this.reservoir = Math.min(
            this.tpmCapacity,
            this.reservoir + (this.tpmCapacity * elapsed) / 60_000,
        );
        this.reservoirRefillAt = now;
    }

    /**
     * Admission gate: refill, then DEBIT `estimate` if the reservoir holds enough.
     * `required` is clamped to capacity so a single request larger than the whole
     * bucket still admits once the reservoir is full (never a deadlock) — its
     * overshoot simply drives the balance negative, throttling the next request.
     * Returns true when admitted (and debited), false when the caller must wait.
     */
    private tryDebitReservoir(estimate: number): boolean {
        if (this.tpmCapacity <= 0 || estimate <= 0) return true;
        this.refillReservoir();
        const required = Math.min(estimate, this.tpmCapacity);
        if (this.reservoir >= required) {
            this.reservoir -= estimate;
            return true;
        }
        return false;
    }

    /** Milliseconds until the reservoir refills enough to admit `estimate`. */
    private reservoirDelayMs(estimate: number): number {
        const required = Math.min(estimate, this.tpmCapacity);
        const deficit = required - this.reservoir;
        if (deficit <= 0) return 0;
        return Math.ceil((deficit * 60_000) / this.tpmCapacity);
    }

    /**
     * POST-call correction: the admission step debited the pre-call `estimate`;
     * adjust by (estimate − actual) so the NET debit equals the real usage. An
     * over-estimate credits tokens back (capped at capacity — never bank beyond
     * the bucket); an under-estimate debits the shortfall (may go negative).
     */
    private reconcileReservoir(estimate: number, actual: number): void {
        if (this.tpmCapacity <= 0 || estimate <= 0) return;
        this.refillReservoir();
        this.reservoir = Math.min(
            this.tpmCapacity,
            this.reservoir + (estimate - actual),
        );
    }

    /**
     * @param queueTimeoutMs Per-task queue wait timeout. When > 0, the task
     *   is rejected with [BYOK-QUEUE-TIMEOUT] if it cannot acquire a slot within
     *   this duration. Pass 0 (or omit) for infinite wait (review callers).
     *   Conversation callers pass 60_000 to fail fast when a review holds the slot.
     */
    run<T>(
        label: string,
        fn: () => Promise<T>,
        abortSignal?: AbortSignal,
        queueTimeoutMs = DEFAULT_LIMITER_QUEUE_TIMEOUT_MS,
        estimatedTokens?: number,
        getUsageTokens?: (result: T) => number | undefined,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const task: QueuedTask<T> = {
                id: this.nextTaskId++,
                label,
                run: fn,
                resolve,
                reject,
                started: false,
                cancelled: false,
                estimatedTokens,
                getUsageTokens,
            };

            const abortQueuedTask = () => {
                if (task.started || task.cancelled) return;
                task.cancelled = true;
                if (task.timer) clearTimeout(task.timer);
                const index = this.queue.findIndex(
                    (item) => item.id === task.id,
                );
                if (index >= 0) {
                    this.queue.splice(index, 1);
                }
                reject(
                    abortSignal?.reason instanceof Error
                        ? abortSignal.reason
                        : new Error(
                              `[BYOK-QUEUE-ABORTED] ${label} was cancelled before acquiring an LLM concurrency slot`,
                          ),
                );
            };

            if (abortSignal) {
                if (abortSignal.aborted) {
                    abortQueuedTask();
                    return;
                }
                abortSignal.addEventListener('abort', abortQueuedTask, {
                    once: true,
                });
                task.cleanup = () =>
                    abortSignal.removeEventListener('abort', abortQueuedTask);
            }

            if (queueTimeoutMs > 0) {
                task.timer = setTimeout(() => {
                    if (task.started || task.cancelled) return;
                    task.cancelled = true;
                    task.cleanup?.();
                    const index = this.queue.findIndex(
                        (item) => item.id === task.id,
                    );
                    if (index >= 0) {
                        this.queue.splice(index, 1);
                    }
                    this.emitThrottleSignal('queue-timeout', queueTimeoutMs);
                    reject(
                        new Error(
                            `[BYOK-QUEUE-TIMEOUT] ${label} waited more than ${Math.round(
                                queueTimeoutMs / 1000,
                            )}s for an LLM concurrency slot`,
                        ),
                    );
                }, queueTimeoutMs);
            }

            this.queue.push(task as QueuedTask<unknown>);
            this.drain();
        });
    }

    private drain() {
        while (this.activeCount < this.concurrency && this.queue.length > 0) {
            // Drop a cancelled head WITHOUT consuming a rate/token slot.
            if (this.queue[0].cancelled) {
                this.queue.shift();
                continue;
            }

            // cooldown gate (429-armed): after a classified RATE_LIMIT the slot
            // is HELD until `cooldownUntil`. DELAY (never retry) — schedule ONE
            // re-drain at expiry and stop starting. Checked FIRST (before rpm/tpm)
            // because a rate-limited provider must not be touched at all; it
            // coexists with rpm/tpm on the same instance (arming doesn't reset
            // the rpm window or the tpm reservoir — Pitfall 4).
            if (this.cooldownUntil > Date.now()) {
                if (!this.cooldownTimer) {
                    this.cooldownTimer = setTimeout(() => {
                        this.cooldownTimer = undefined;
                        this.drain();
                    }, this.cooldownUntil - Date.now());
                }
                return;
            }

            // rpm rate gate: DELAY (never retry) the next START if the min-interval
            // since the last actual start hasn't elapsed. Schedule a single
            // re-drain for the remaining time and stop starting early.
            if (this.minInterval > 0) {
                const elapsed = Date.now() - this.lastStartAt;
                if (elapsed < this.minInterval) {
                    if (!this.rateTimer) {
                        this.rateTimer = setTimeout(() => {
                            this.rateTimer = undefined;
                            this.drain();
                        }, this.minInterval - elapsed);
                        this.emitThrottleSignal(
                            'rpm-throttle',
                            this.minInterval - elapsed,
                        );
                    }
                    return;
                }
            }

            // tpm token gate: DEBIT the head task's pre-call estimate from the
            // reservoir. If the reservoir can't cover it yet, schedule ONE
            // re-drain for the refill delay and stop (DELAY, never retry) —
            // exactly like the rpm gate. Composes with rpm + concurrency: all
            // three gates guard the SAME per-slot limiter.
            const head = this.queue[0];
            const estimate = head.estimatedTokens ?? 0;
            if (
                this.tpmCapacity > 0 &&
                estimate > 0 &&
                !this.tryDebitReservoir(estimate)
            ) {
                if (!this.tpmTimer) {
                    const waitMs = this.reservoirDelayMs(estimate);
                    this.tpmTimer = setTimeout(() => {
                        this.tpmTimer = undefined;
                        this.drain();
                    }, waitMs);
                    this.emitThrottleSignal('tpm-throttle', waitMs);
                }
                return;
            }

            const task = this.queue.shift()!;

            task.started = true;
            if (task.timer) clearTimeout(task.timer);
            task.cleanup?.();
            // Stamp the start only when a task ACTUALLY starts (cancelled heads
            // are dropped above without consuming a rate/token slot).
            this.lastStartAt = Date.now();
            this.activeCount++;

            Promise.resolve()
                .then(() => task.run())
                .then(
                    (value) => {
                        // POST-call reconcile: correct the reservoir by
                        // (estimate − actual) from the real usage total BEFORE
                        // the finally re-drain, so the corrected balance gates
                        // the next task. Skip when usage is unavailable — the
                        // pre-call estimate then stands as the net debit.
                        if (
                            this.tpmCapacity > 0 &&
                            (task.estimatedTokens ?? 0) > 0
                        ) {
                            const actual = task.getUsageTokens?.(value);
                            if (typeof actual === 'number' && actual >= 0) {
                                this.reconcileReservoir(
                                    task.estimatedTokens as number,
                                    actual,
                                );
                            }
                        }
                        task.resolve(value);
                    },
                    (error) => {
                        // P1: the admission gate already DEBITED the full pre-call
                        // estimate, but a FAILED call (429 / timeout / network)
                        // consumed ~0 tokens. Credit the un-consumed estimate back
                        // before rejecting — mirroring the success-path reconcile
                        // guard — so a provider outage of N failing calls does not
                        // permanently drain the reservoir and over-throttle the
                        // recovery. (reconcile(estimate, 0) credits the full
                        // estimate back, capped at capacity.)
                        if (
                            this.tpmCapacity > 0 &&
                            (task.estimatedTokens ?? 0) > 0
                        ) {
                            this.reconcileReservoir(
                                task.estimatedTokens as number,
                                0,
                            );
                        }
                        task.reject(error);
                    },
                )
                .finally(() => {
                    this.activeCount = Math.max(0, this.activeCount - 1);
                    this.drain();
                });
        }
    }
}

const limiterCache = new Map<string, BYOKConcurrencyLimiter>();

// P2: the limiter cache is keyed on the (ciphertext) apiKey, so an API-key
// rotation for the same org/model mints a NEW cache entry and orphans the old
// limiter (its queue array + any pending rate/reservoir/cooldown timer) forever.
// Bound the cache: when it exceeds this cap, evict IDLE limiters LRU-style
// (least-recently-used first). A limiter with queued or in-flight work, or a
// pending timer, is NEVER evicted.
const LIMITER_CACHE_MAX = 500;

/**
 * P2: evict IDLE limiters when the cache exceeds its cap. The Map iterates in
 * insertion order and `runWithBYOKLimiter` re-inserts on reuse, so the least-
 * recently-used entries come first (LRU). Only IDLE limiters (empty queue, no
 * in-flight work, no pending rate/reservoir/cooldown timer) are removed — an
 * active or throttled limiter is skipped so its queue/timers are never dropped.
 */
function evictIdleLimiters(): void {
    if (limiterCache.size <= LIMITER_CACHE_MAX) return;
    for (const [key, limiter] of limiterCache) {
        if (limiterCache.size <= LIMITER_CACHE_MAX) break;
        if (limiter.isIdle()) {
            limiterCache.delete(key);
        }
    }
}

function buildLimiterCacheKey(params: {
    slot?: NormalizedModel;
    organizationId?: string;
}): string | null {
    const config = params.slot;
    if (!config) return null;

    const organizationScope = params.organizationId || 'global';
    return [
        organizationScope,
        config.provider,
        config.apiKey,
        config.baseURL || '',
        config.model,
    ].join('::');
}

/**
 * Reach the cached per-slot limiter for a slot (same identity key
 * `runWithBYOKLimiter` uses), or null when none exists yet. The wrapper catch
 * uses it to `armCooldown` on a classified RATE_LIMIT; the retry owner
 * (structured-review-call) uses it to `isInCooldown()` before re-issuing. Never
 * constructs a limiter — a slot that never ran has no cached limiter (null).
 * Reads/returns no key material beyond the opaque ciphertext already in the slot.
 */
export function getLimiterForSlot(params: {
    slot?: NormalizedModel;
    organizationId?: string;
}): BYOKConcurrencyLimiter | null {
    const cacheKey = buildLimiterCacheKey(params);
    if (!cacheKey) return null;
    return limiterCache.get(cacheKey) ?? null;
}

/**
 * Runs a task through a BYOK concurrency limiter scoped by organization + provider account.
 *
 * The limiter keys off the ONE resolved slot passed in — no `.main`/`.fallback`
 * role switch. Calls hitting the same provider account share a limiter because
 * upstream concurrency limits are account-wide rather than call-type-specific.
 */
export function runWithBYOKLimiter<T>(
    params: {
        slot?: NormalizedModel;
        organizationId?: string;
        queueTimeoutMs?: number;
        abortSignal?: AbortSignal;
        /** PRE-call tiktoken estimate of the request's prompt tokens. Debits the
         *  tpm reservoir at admission. Supplied by the wrapper (the only seam
         *  with params.prompt); omit for a non-tpm call (zero overhead). */
        estimatedTokens?: number;
        /** Extracts the POST-call real token total from the task result so the
         *  reservoir reconciles estimate vs actual. Supplied by the wrapper (the
         *  only seam with doGenerate().usage). */
        getUsageTokens?: (result: T) => number | undefined;
    },
    fn: () => Promise<T>,
    label = 'llm-call',
): Promise<T> {
    const maxConcurrent = params.slot?.maxConcurrentRequests;
    const rpm = params.slot?.rpm;
    const tpm = params.slot?.tpm;
    const cooldownMs = params.slot?.cooldownMs;

    const hasConcurrency = !!maxConcurrent && maxConcurrent > 0;
    const hasRpm = !!rpm && rpm > 0;
    const hasTpm = !!tpm && tpm > 0;
    // A cooldown-capable slot must NOT fast-path even before any 429: it needs a
    // cached limiter so the wrapper catch can arm it and the retry owner can
    // query it. The gate stays inert (cooldownUntil=0) until actually armed.
    const hasCooldown = !!cooldownMs && cooldownMs > 0;

    // Fast path ONLY when ALL gates are unset — identical to pre-rpm behavior.
    if (!hasConcurrency && !hasRpm && !hasTpm && !hasCooldown) {
        return fn();
    }

    const cacheKey = buildLimiterCacheKey(params);
    if (!cacheKey) {
        return fn();
    }

    // An rpm-only OR tpm-only slot has no concurrency cap: the drain gate is
    // `activeCount < concurrency`, so `concurrency` MUST be Infinity (unbounded)
    // when maxConcurrentRequests is unset/≤0 — otherwise `0 < undefined` is
    // false and the queue never starts (deadlock). With Infinity the concurrency
    // gate is a no-op and only the rpm min-interval / tpm reservoir throttles.
    const concurrency = hasConcurrency ? (maxConcurrent as number) : Infinity;

    const queueTimeoutMs =
        params.queueTimeoutMs ?? DEFAULT_LIMITER_QUEUE_TIMEOUT_MS;
    let limiter = limiterCache.get(cacheKey);
    if (!limiter) {
        limiter = new BYOKConcurrencyLimiter(
            concurrency,
            rpm,
            tpm,
            params.slot?.provider,
            params.slot?.model,
        );
        limiterCache.set(cacheKey, limiter);
        // P2: bound the cache after inserting a new (rotated-key) limiter.
        evictIdleLimiters();
    } else {
        // LRU touch: move the reused limiter to the most-recently-used end so
        // eviction targets genuinely stale entries first (P2). delete+set
        // re-inserts at the tail of the Map's insertion order.
        limiterCache.delete(cacheKey);
        limiterCache.set(cacheKey, limiter);
        // Re-tune the cached limiter (identity fields unchanged) instead of
        // constructing a new one that would discard in-flight queue/rate/token
        // state (Pitfall 4). A config edit re-tunes; it never resets the throttle
        // or reseeds the reservoir. tpm is NOT an identity field.
        limiter.configure({ concurrency, rpm, tpm });
    }

    return limiter.run(
        label,
        fn,
        params.abortSignal,
        queueTimeoutMs,
        params.estimatedTokens,
        params.getUsageTokens,
    );
}

// Internal — exported for the bounded-cache tests (P2). Exposes the module
// limiter cache and its cap so a test can rotate keys past the cap and assert
// the Map does not grow unbounded. Never surfaces key material beyond the
// opaque ciphertext already inside the cache keys.
export const __limiterCacheInternals = {
    cache: limiterCache,
    max: LIMITER_CACHE_MAX,
};
