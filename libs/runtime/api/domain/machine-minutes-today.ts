import { effectiveMachineMinuteLimit, type MachineMinuteLimitSource, machineMinuteLimitSource, remainingMachineMinutes } from '@libs/runtime/environment/machine-minutes';

/** What runtime.runtime_machine_usage sums for one org on the current UTC day. */
export interface RuntimeMachineUsageToday {
    /** What counts against the limit: settled rounds plus the whole ceiling of each round still running. */
    seconds: number;
    /** What the machines actually held so far. */
    heldSeconds: number;
    /** Rounds still running (a setup boot, a Run side, an environment session). */
    openRounds: number;
    /** The org's own daily machine minutes (runtime.runtime_org_machine_budget); null or absent = the deployment's. */
    orgLimitMinutes?: number | null;
}

/** GET /runtime/settings/machine-minutes: the org's machine minutes of the current UTC day. */
export interface RuntimeMachineMinutesToday {
    /** The limit the hub holds the org to today: the lower of the deployment's and the org's own; null when unlimited. */
    limitMinutes: number | null;
    /** RUNTIME_MACHINE_MINUTES_PER_ORG_DAY; null when unlimited (0). */
    deploymentLimitMinutes: number | null;
    /** The org's own limit (PATCH /runtime/settings/machine-minutes); null = none. It never raises the deployment's. */
    orgLimitMinutes: number | null;
    /** Which of the two is limitMinutes. */
    limitSource: MachineMinuteLimitSource;
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

export function machineMinutesToday(usage: RuntimeMachineUsageToday, deploymentLimitMinutes: number, now: Date): RuntimeMachineMinutesToday {
    const orgLimitMinutes = usage.orgLimitMinutes && usage.orgLimitMinutes > 0 ? usage.orgLimitMinutes : null;
    const limitMinutes = effectiveMachineMinuteLimit(deploymentLimitMinutes, orgLimitMinutes);
    const committedMinutes = minutesOf(usage.seconds);
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return {
        limitMinutes: limitMinutes > 0 ? limitMinutes : null,
        deploymentLimitMinutes: deploymentLimitMinutes > 0 ? deploymentLimitMinutes : null,
        orgLimitMinutes,
        limitSource: machineMinuteLimitSource(deploymentLimitMinutes, orgLimitMinutes),
        committedMinutes,
        usedMinutes: Math.min(minutesOf(usage.heldSeconds), committedMinutes),
        openRounds: usage.openRounds,
        remainingMinutes: remainingMachineMinutes(usage.seconds, limitMinutes),
        resetsAt: resetsAt.toISOString(),
    };
}
