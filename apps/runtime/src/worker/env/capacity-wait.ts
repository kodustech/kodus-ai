import { type AcquireRequest, type Blocked, type Claim, type EnvironmentRuntime, isCapacityWait } from '@libs/runtime/environment';

import { CellUnavailableError, HubUnreachableError, NoCellConnectedError } from '../../shared/errors';

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

// A cell that drops its connection while it prepares a claim keeps preparing
// it, and joins the same claim when it is asked again (the cell's rejoin; the
// hub rebinds the round). So cell_lost is a pause too: the worker asks again
// with the same key until the cell is back. The budget is its own, counted
// from the loss (a boot is lost long after the budget for room ended), and
// ends before the cell's dead-man stops machines that lost the hub (5 min).
export const CELL_LOST_WAIT_MS = 4 * 60_000;

/** The cell disconnected while it prepared the claim (the hub's cell_lost), and nothing else. */
export const isCellLost = (r: Claim | Blocked): r is Blocked =>
    (r as Blocked).status === 'blocked' &&
    (r as Blocked).blockers.length > 0 &&
    (r as Blocked).blockers.every((b) => b.kind === 'platform' && b.signature === 'cell_lost');

/**
 * No host is connected for the organization on the claim's first ask: nothing
 * was sent and nothing will come by waiting the Run's budget, so the claim
 * ends now with the catalog's cell_unavailable card (boat.dev answers "no
 * machine ready" within seconds). While a claim waits for room it is a pause.
 */
export const NO_CELL_CONNECTED: Blocked = {
    status: 'blocked',
    blockers: [{ kind: 'platform', signature: 'cell_unavailable', message: 'no cell is connected for this organization; the claim was not started' }],
};

/** What a round the hub did not answer stands for: the claim's cell is out of reach, as when it drops. */
const HUB_DROPPED: Blocked = { status: 'blocked', blockers: [{ kind: 'platform', signature: 'cell_lost', message: 'the hub did not answer while the claim was booting' }] };

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
    /** How long a claim whose cell disconnected mid-boot is asked again (default CELL_LOST_WAIT_MS). */
    cellLostWaitMs?: number;
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
    // Set while the last answer is cell_lost: when asking again for that claim stops.
    let lostUntil: number | undefined;
    // The hub's last error: a wait that ends on a round it did not answer ends with it.
    let unreachable: HubUnreachableError | undefined;
    const ended = (claim: Blocked, waitedMs: number, rounds: number): CapacityWaitResult => {
        if (claim === HUB_DROPPED && unreachable) throw unreachable;
        return { claim, waitedMs, rounds };
    };
    for (let round = 1; ; round++) {
        opts.signal?.throwIfAborted();
        const askedAt = opts.now().getTime();
        if (last && askedAt >= (lostUntil ?? opts.until)) return ended(last, askedAt - start, round - 1);
        let claim: Claim | Blocked;
        try {
            claim = await env.acquire(req);
        } catch (e) {
            opts.signal?.throwIfAborted();
            if (e instanceof HubUnreachableError) {
                // The hub dropped or refused the acquire (a replica restarting), also on the first
                // round: the cell keeps preparing the claim and joins it when asked again with the
                // same key, as after cell_lost, so the claim is asked again within that budget.
                unreachable = e;
                claim = last && !isCellLost(last) ? last : HUB_DROPPED;
            } else {
                // A hub that restarts while the claim waits for room (the dev cell: both waiting Runs
                // errored on ECONNREFUSED) is a pause, not an end: the claim started nothing, so it
                // keeps waiting within the same budget. On the first round the error stands
                // (no cell connected for the org at all).
                if (e instanceof NoCellConnectedError && !last) return { claim: NO_CELL_CONNECTED, waitedMs: 0, rounds: round };
                if (!(e instanceof CellUnavailableError) || !last) throw e;
                claim = last;
            }
        }
        opts.signal?.throwIfAborted();
        const waitedMs = askedAt - start;
        if (isCellLost(claim)) lostUntil ??= opts.now().getTime() + (opts.cellLostWaitMs ?? CELL_LOST_WAIT_MS);
        else if (isCapacityWait(claim)) lostUntil = undefined;
        else return { claim, waitedMs, rounds: round };
        last = claim;
        const pause = Math.round(backoff[Math.min(round - 1, backoff.length - 1)] * jitter());
        if (opts.now().getTime() + pause > (lostUntil ?? opts.until)) return ended(claim, waitedMs, round);
        try {
            // Progress is about room: a lost cell is not shown as a claim that waits for memory.
            if (lostUntil === undefined) await opts.onWait?.({ blocked: claim, waitedMs: opts.now().getTime() - start, round });
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
