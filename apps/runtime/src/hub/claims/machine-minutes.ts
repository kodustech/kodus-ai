import type { MachineMinutesDecision } from '@libs/runtime/environment';

/**
 * Where the hub reserves a claim round's machine minutes before anything is
 * recorded or sent (ClaimService.acquireRound). `reserve` decides and writes
 * in one step per org day; `cancel` gives back the round of a claim that never
 * reached a cell. A round that reached one counts what it held once the
 * claim row says it ended: nobody settles it.
 */
export interface MachineMinuteStore {
    reserve(input: { claimId: string; organizationId: string; needSeconds: number; limitMinutes: number }): Promise<MachineMinutesDecision>;
    cancel(claimId: string): Promise<void>;
}

/** The budget a hub enforces: the store and RUNTIME_MACHINE_MINUTES_PER_ORG_DAY (0 = unlimited, still counted). */
export interface MachineMinuteBudget {
    store: MachineMinuteStore;
    limitMinutes: number;
}
