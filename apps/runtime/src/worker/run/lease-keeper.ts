import type { EnvError, LeaseRenewal } from '@libs/runtime/environment';
import { LEASE_TTL_MINUTES } from '@libs/runtime/environment';

import type { ClaimLeases, LeaseHold } from './ports';

// Keeps a working Run's claims leased (claim.renew through the hub, §1b).
// A claim's lease is LEASE_TTL_MINUTES from its acquire; without renewal the
// cell sweeps the machines then, whatever the Run is doing, before the claim's
// hard ceiling. The keeper renews every third of the TTL while the Run holds
// it, and stops for good on the Run's end (stop), on a claim the hub says is
// gone, and on a claim whose lease reached its hard ceiling (nothing left to
// move). The hub and the cell both clamp to the ceiling, so no renewal can
// keep machines past hardExpiresAt.
//
// Why here and not as DBOS steps: a renewal has to happen while a long step
// (the agent's plan, a probe) is running, and steps of one workflow run in a
// fixed order, so a step on a timer would make the journal depend on timing.
// The keeper is outside the journal: it reads nothing the workflow decides on
// and writes nothing the workflow reads, so replay sees the same steps. On a
// worker crash the renewals stop with the process (the lease then runs out,
// as it should for a Run nobody runs); a resumed workflow replays its boot
// from the journal and starts the keeper again on the same claims. Why not a
// hub-side timer: only the worker knows the Run is still working.

export type RenewClaim = (claimId: string) => Promise<LeaseRenewal | EnvError>;

/** What the keeper saw, for the worker's log (ids only). */
export type LeaseEvent =
    | { type: 'renewed'; claimId: string; leaseExpiresAt: string; atCeiling: boolean }
    | { type: 'gone'; claimId: string }
    | { type: 'retry'; claimId: string; error: string };

export interface Timers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
    setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        // A pending renewal never keeps a worker that is shutting down alive.
        t.unref?.();
        return t;
    },
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface LeaseKeeperOptions {
    /** Between renewals of a claim; a third of the Run's lease by default. */
    everyMs?: number;
    /** After a renewal that did not reach the cell (hub or cell out of reach). */
    retryMs?: number;
    timers?: Timers;
    onEvent?: (e: LeaseEvent) => void;
}

export const RENEW_EVERY_MS = Math.floor((LEASE_TTL_MINUTES.runtime * 60_000) / 3);
export const RENEW_RETRY_MS = 60_000;

export class ClaimLeaseKeeper implements ClaimLeases {
    private readonly everyMs: number;
    private readonly retryMs: number;
    private readonly timers: Timers;

    constructor(
        private readonly renew: RenewClaim,
        private readonly opts: LeaseKeeperOptions = {},
    ) {
        this.everyMs = opts.everyMs ?? RENEW_EVERY_MS;
        this.retryMs = opts.retryMs ?? RENEW_RETRY_MS;
        this.timers = opts.timers ?? realTimers;
    }

    keep(claimIds: string[]): LeaseHold {
        const live = new Set(claimIds);
        let stopped = false;
        let handle: unknown;
        const emit = (e: LeaseEvent) => {
            try {
                this.opts.onEvent?.(e);
            } catch {
                // a log sink that throws never stops the renewals
            }
        };
        const schedule = (ms: number) => {
            if (stopped || !live.size) return;
            handle = this.timers.setTimeout(() => void tick(), ms);
        };
        const renewOne = async (claimId: string): Promise<boolean> => {
            try {
                const r = await this.renew(claimId);
                if (stopped) return false;
                if ('code' in r) {
                    emit({ type: 'retry', claimId, error: r.code });
                    return true;
                }
                if (r.status === 'gone') {
                    live.delete(claimId);
                    emit({ type: 'gone', claimId });
                    return false;
                }
                if (r.atCeiling) live.delete(claimId);
                emit({ type: 'renewed', claimId, leaseExpiresAt: r.leaseExpiresAt, atCeiling: r.atCeiling });
                return false;
            } catch (e) {
                // A lost cell or hub is the next try's business, never the Run's.
                if (!stopped) emit({ type: 'retry', claimId, error: (e as Error)?.message ?? String(e) });
                return true;
            }
        };
        const tick = async () => {
            if (stopped) return;
            const retry = await Promise.all([...live].map(renewOne));
            schedule(retry.some(Boolean) ? this.retryMs : this.everyMs);
        };
        schedule(this.everyMs);
        return {
            stop: () => {
                stopped = true;
                if (handle !== undefined) this.timers.clearTimeout(handle);
            },
        };
    }
}

/**
 * A Run's renewals, one claim at a time: a side is kept from the moment its
 * claim is bound, not once both sides booted. A side that waits for room on a
 * cell (ADR-070, up to 30 min) would otherwise leave the other side's lease
 * (45 min from its acquire) to lapse before the first renewal. stop() ends
 * every renewal; a claim added after it is not kept.
 */
export class RunLeaseHolds implements LeaseHold {
    private readonly holds = new Map<string, LeaseHold>();
    private stopped = false;

    constructor(private readonly leases?: ClaimLeases) {}

    add(claimId: string): void {
        if (this.stopped || !this.leases || this.holds.has(claimId)) return;
        this.holds.set(claimId, this.leases.keep([claimId]));
    }

    /** Stops renewing one claim (one the Run gives back before it ends). */
    drop(claimId: string): void {
        this.holds.get(claimId)?.stop();
        this.holds.delete(claimId);
    }

    stop(): void {
        this.stopped = true;
        for (const h of this.holds.values()) h.stop();
        this.holds.clear();
    }
}
