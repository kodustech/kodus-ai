import { type AcquireRequest, type Blocked, type Claim, type EnvironmentRuntime, isCapacityWait } from '@libs/runtime/environment';

import { CellUnavailableError } from '../../shared/errors';

// Waiting for room on a cell (ADR-070). A claim the cell directory or the
// hub refuses for room (no slot, no memory, or the org's cap of shared
// machines: isCapacityWait) never started anything: the worker asks again
// after a pause, with the same idempotency key, until it is admitted or the
// caller's budget ends. The hub keeps the order of claims that wait on a
// cell (cell-memory.ts), so asking again keeps the claim's place. Each
// round is a plain acquire: a worker that restarts mid-wait asks again from
// the top, which is the same claim.

/** Pauses between rounds: short at first, then every 15 s (the hub drops a waiter that has not asked for 60 s). */
export const CAPACITY_BACKOFF_MS = [5_000, 10_000, 15_000] as const;

export interface CapacityWaitOptions {
    /** No new round starts after this (epoch ms); the last refusal is returned. */
    until: number;
    now: () => Date;
    sleep?: (ms: number) => Promise<void>;
    /** Cancellation belongs to the calling workflow; never start another acquire after it. */
    signal?: AbortSignal;
    /** Each refusal before a pause (best effort: a failure is ignored). */
    onWait?: (w: { blocked: Blocked; waitedMs: number; round: number }) => Promise<void> | void;
    backoffMs?: readonly number[];
    /** 0.8 to 1.2 of each pause, so claims refused together do not all ask again in the same instant. */
    jitter?: () => number;
}

export interface CapacityWaitResult {
    claim: Claim | Blocked;
    /** From the first round until the round that was answered started: the time spent waiting for room. */
    waitedMs: number;
    rounds: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pauseForRoom(ms: number, sleep: CapacityWaitOptions['sleep'], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) return (sleep ?? realSleep)(ms);
    return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (done: () => void) => {
            signal.removeEventListener('abort', abort);
            if (timer !== undefined) clearTimeout(timer);
            done();
        };
        const abort = () => finish(() => reject(signal.reason));
        signal.addEventListener('abort', abort, { once: true });
        if (sleep) {
            Promise.resolve()
                .then(() => {
                    signal.throwIfAborted();
                    return sleep(ms);
                })
                .then(() => finish(resolve), (error) => finish(() => reject(error)));
        } else {
            timer = setTimeout(() => finish(resolve), ms);
        }
    });
}

export async function acquireWaitingForRoom(env: Pick<EnvironmentRuntime, 'acquire'>, req: AcquireRequest, opts: CapacityWaitOptions): Promise<CapacityWaitResult> {
    const backoff = opts.backoffMs ?? CAPACITY_BACKOFF_MS;
    const jitter = opts.jitter ?? (() => 0.8 + Math.random() * 0.4);
    const start = opts.now().getTime();
    let last: Blocked | undefined;
    for (let round = 1; ; round++) {
        opts.signal?.throwIfAborted();
        const askedAt = opts.now().getTime();
        if (last && askedAt >= opts.until) return { claim: last, waitedMs: askedAt - start, rounds: round - 1 };
        let claim: Claim | Blocked;
        try {
            claim = await env.acquire(req);
        } catch (e) {
            opts.signal?.throwIfAborted();
            // A hub that restarts while the claim waits for room (cell-dev-1: both waiting Runs
            // errored on ECONNREFUSED) is a pause, not an end: the claim started nothing, so it
            // keeps waiting within the same budget. On the first round the error stands, as before.
            if (!(e instanceof CellUnavailableError) || !last) throw e;
            claim = last;
        }
        opts.signal?.throwIfAborted();
        const waitedMs = askedAt - start;
        if (!isCapacityWait(claim)) return { claim, waitedMs, rounds: round };
        last = claim;
        const pause = Math.round(backoff[Math.min(round - 1, backoff.length - 1)] * jitter());
        if (opts.now().getTime() + pause > opts.until) return { claim, waitedMs, rounds: round };
        try {
            await opts.onWait?.({ blocked: claim, waitedMs: opts.now().getTime() - start, round });
        } catch {
            // A progress update never stops the wait.
        }
        await pauseForRoom(pause, opts.sleep, opts.signal);
    }
}

/** One line for a claim that waited past its budget: why, from the last refusal. */
export function capacityWaitReason(side: string, blocked: Blocked, waitedMs: number): string {
    const b = blocked.blockers[0];
    const minutes = Math.max(1, Math.round(waitedMs / 60_000));
    return `the ${side} machine waited ${minutes} min for room on a cell and none had it (${b?.signature ?? 'no_capacity'}: ${b?.message ?? 'no room'})`;
}
