import { estimateDurations, type SpecStats, type SuiteSpecFile } from './balance';

// The dynamic spec queue's pure rules (docs/runtime/e2e-suites.md section 6, "Dynamic queue"): what goes into a suite run's
// queue and in which order, how much a shard takes at once, and what happens to a claim that is not finished in time. The
// store (`PgSuiteQueue`) and the engine apply them; nothing here reads a clock or a database.

/** A claim is a lease: a shard that does not renew it within this time is taken to be dead and its specs go back to the queue. */
export const QUEUE_LEASE_MS = 3 * 60_000;
/** A spec is handed out at most this many times (the first claim and one more after a lost shard); past it the spec is `infra` for the fresh host. */
export const QUEUE_MAX_ATTEMPTS = 2;
/** A shard takes about this much estimated work per pull: a short spec rides with others (one runner start for all), a long one goes alone. */
export const QUEUE_BATCH_TARGET_MS = 60_000;
/** Never more specs than this in one pull, whatever their estimates. */
export const QUEUE_BATCH_MAX_SPECS = 5;
/** How often an idle shard looks at the queue again (a peer's lease may have lapsed). */
export const QUEUE_IDLE_POLL_MS = 5_000;

export interface QueueEntry {
    spec: string;
    /** 0: red on the previous push; 1: covers the diff; 2: the rest (the risk-first order of 6.1, now the queue's). */
    priority: 0 | 1 | 2;
    /** The order key inside a priority, larger first: the estimated ms, else the file size in bytes. */
    weight: number;
    /** The estimated ms, absent with no stored duration at all: such a spec is pulled alone. */
    estMs?: number;
}

/**
 * The queue of a run, in the order it is handed out: risk first (red before, then covering the diff), then longest first by the
 * stored duration (the longest-processing-time rule, now applied while the run goes instead of once up front), the file size
 * when nothing is stored, the path last so the order never depends on how the specs arrive.
 */
export function queueEntries(i: { specs: readonly SuiteSpecFile[]; stats: SpecStats; failedBefore?: readonly string[]; diffCoverage?: Readonly<Record<string, number>> }): QueueEntry[] {
    const durations = estimateDurations(i.specs, i.stats);
    const failed = new Set(i.failedBefore ?? []);
    return i.specs
        .map((s): QueueEntry => {
            const estMs = durations ? Math.round(durations.get(s.path)!) : undefined;
            return { spec: s.path, priority: failed.has(s.path) ? 0 : (i.diffCoverage?.[s.path] ?? 0) > 0 ? 1 : 2, weight: estMs ?? s.sizeBytes, ...(estMs !== undefined ? { estMs } : {}) };
        })
        .sort((a, b) => a.priority - b.priority || b.weight - a.weight || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));
}

/**
 * How many of the next entries one pull takes: from the head of the queue until their estimates add up to `targetMs` (the first is
 * always taken, so a long spec goes alone), at most `maxSpecs`. An entry with no estimate counts as the whole target. The store
 * applies the same rule in SQL; this is its reference.
 */
export function batchSize(next: ReadonlyArray<{ estMs?: number }>, o: { targetMs?: number; maxSpecs?: number } = {}): number {
    const target = o.targetMs ?? QUEUE_BATCH_TARGET_MS;
    const max = o.maxSpecs ?? QUEUE_BATCH_MAX_SPECS;
    let before = 0;
    let n = 0;
    for (const e of next) {
        if (n >= max || (n > 0 && before >= target)) break;
        before += e.estMs ?? target;
        n++;
    }
    return n;
}

/** What a claim that was not finished becomes: back in the queue while it has attempts left, else abandoned (the engine reports it `infra`). */
export function afterLostClaim(attempts: number, maxAttempts: number = QUEUE_MAX_ATTEMPTS): 'queued' | 'abandoned' {
    return attempts < maxAttempts ? 'queued' : 'abandoned';
}

/** Whether a claim's lease has run out at `now` (epoch ms). */
export const leaseExpired = (leaseExpiresAt: number, now: number): boolean => leaseExpiresAt <= now;
