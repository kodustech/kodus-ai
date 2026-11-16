import { remainingMachineMinutes } from '@libs/runtime/environment/machine-minutes';

/** What runtime.runtime_machine_usage sums for one org on the current UTC day. */
export interface RuntimeMachineUsageToday {
    /** What counts against the limit: settled rounds plus the whole ceiling of each round still running. */
    seconds: number;
    /** What the machines actually held so far. */
    heldSeconds: number;
    /** Rounds still running (a setup boot, a Run side, an environment session). */
    openRounds: number;
}

/** GET /runtime/settings/machine-minutes: the org's machine minutes of the current UTC day. */
export interface RuntimeMachineMinutesToday {
    /** RUNTIME_MACHINE_MINUTES_PER_ORG_DAY; null when unlimited (0). */
    limitMinutes: number | null;
    /** Minutes counted against the limit, including what running machines reserved and may still use. */
    committedMinutes: number;
    /** Minutes machines actually ran; at most committedMinutes. */
    usedMinutes: number;
    openRounds: number;
    /** Minutes left before new setups and Runs wait for the reset; null when unlimited. */
    remainingMinutes: number | null;
    /** The next 00:00 UTC, when the day's count starts over. */
    resetsAt: string;
}

const minutesOf = (seconds: number) => Math.ceil(Math.max(0, seconds) / 60);

export function machineMinutesToday(usage: RuntimeMachineUsageToday, limitMinutes: number, now: Date): RuntimeMachineMinutesToday {
    const committedMinutes = minutesOf(usage.seconds);
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return {
        limitMinutes: limitMinutes > 0 ? limitMinutes : null,
        committedMinutes,
        usedMinutes: Math.min(minutesOf(usage.heldSeconds), committedMinutes),
        openRounds: usage.openRounds,
        remainingMinutes: remainingMachineMinutes(usage.seconds, limitMinutes),
        resetsAt: resetsAt.toISOString(),
    };
}
