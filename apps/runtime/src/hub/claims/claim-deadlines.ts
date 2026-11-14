import { type Consumer, HARD_EXPIRY_MINUTES, LEASE_TTL_MINUTES, READY_TIMEOUT_MINUTES } from '@libs/runtime/environment';

import type { ClaimRow } from '../hub-store';

/** The two times a claim.acquire carries, and the hub records and hands the worker. */
export interface ClaimDeadlines {
    leaseExpiresAt: string;
    hardExpiresAt: string;
}

const MINUTE = 60_000;

/** A claim's first round: its consumer's lease and ceiling from `at`. */
export function freshDeadlines(consumer: Consumer, at: number): ClaimDeadlines {
    return {
        leaseExpiresAt: new Date(at + LEASE_TTL_MINUTES[consumer] * MINUTE).toISOString(),
        hardExpiresAt: new Date(at + HARD_EXPIRY_MINUTES[consumer] * MINUTE).toISOString(),
    };
}

/**
 * The deadlines of a retried round of a claim the hub already recorded.
 *
 * A cell that still holds the claim (booting or ready) rejoins it and keeps
 * the body of the round that created it (apps/runtime-cell/internal/agent/
 * acquire.go rejoin): its machines expire at that round's lease and are
 * destroyed at that round's ceiling, whatever a retry says. So a retry on
 * the cell the claim was last sent to reuses the recorded deadlines while
 * the ceiling is still ahead: what the hub records and hands the worker is
 * then what the cell enforces, and a retry never stretches a claim's
 * lifetime past its first ceiling (S-08). When the cell no longer holds the
 * claim it boots it again under those same deadlines.
 *
 * A retry on another cell, or after the ceiling passed (no cell still holds
 * the claim), is a new boot: fresh deadlines. A recorded lease already past
 * is not resent (the cell would fall back to its own initial lease); the
 * fresh one, never past the ceiling, is.
 */
export function retryDeadlines(previous: Pick<ClaimRow, 'cellId' | 'hardExpiresAt' | 'leaseExpiresAt'>, cellId: string, fresh: ClaimDeadlines, at: number): ClaimDeadlines {
    const hard = Date.parse(previous.hardExpiresAt);
    if (previous.cellId !== cellId || !(hard > at)) return fresh;
    const recorded = previous.leaseExpiresAt ? Date.parse(previous.leaseExpiresAt) : NaN;
    const lease = recorded > at ? recorded : Date.parse(fresh.leaseExpiresAt);
    return { leaseExpiresAt: new Date(Math.min(lease, hard)).toISOString(), hardExpiresAt: previous.hardExpiresAt };
}

/**
 * How long the hub waits for claim.ready: the consumer's wait, and never
 * past a minute before the ceiling the cell enforces (READY_TIMEOUT_MINUTES),
 * which a retried round may have nearer than a first one.
 */
export function readyWaitMs(consumer: Consumer, deadlines: ClaimDeadlines, at: number): number {
    return Math.max(0, Math.min(READY_TIMEOUT_MINUTES[consumer] * MINUTE, Date.parse(deadlines.hardExpiresAt) - at - MINUTE));
}
