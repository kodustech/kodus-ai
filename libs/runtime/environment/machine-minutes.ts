import { type Blocked, type Consumer, HARD_EXPIRY_MINUTES } from './environment-runtime';

// The org's machine-minute budget (§11): wall-clock minutes of cell machines
// (setup boots, Run sides, environment sessions) per organization per UTC
// day. The hub reserves a claim's whole ceiling when it admits a round, before
// anything is sent to a cell, and the round counts what it actually held once
// it ends (runtime.runtime_machine_org_day). So two claims admitted at once
// never both pass the day's last minutes: no machine is admitted that could
// take the day past its limit.

/** RUNTIME_MACHINE_MINUTES_PER_ORG_DAY when unset: about 166 machine hours a day. 0 = unlimited. */
export const DEFAULT_MACHINE_MINUTES_PER_ORG_DAY = 10_000;

/** The blocker signature of a claim the org's daily machine minutes cannot hold. */
export const MACHINE_MINUTES_EXHAUSTED = 'machine_minutes_exhausted';

/** Which limit refused: the deployment's (RUNTIME_MACHINE_MINUTES_PER_ORG_DAY) or the org's own (Runtime settings). */
export type MachineMinuteLimitSource = 'deployment' | 'org';

export type MachineMinutesDecision =
    | { allowed: true }
    | { allowed: false; spentMinutes: number; limitMinutes: number; needMinutes: number; source?: MachineMinuteLimitSource };

/** The org's own daily machine minutes (Runtime settings): a positive whole number, at most a day of 10 000 machines. */
export const MAX_ORG_MACHINE_MINUTES_PER_DAY = 14_400_000;

/**
 * The limit the hub holds an org to: the org's own setting can lower the
 * deployment's RUNTIME_MACHINE_MINUTES_PER_ORG_DAY, never raise it; on a
 * deployment without one (0) the org's setting alone applies. 0 = unlimited.
 */
export function effectiveMachineMinuteLimit(deploymentMinutes: number, orgMinutes: number | null | undefined): number {
    if (!orgMinutes || orgMinutes <= 0) return Math.max(0, deploymentMinutes);
    return deploymentMinutes > 0 ? Math.min(deploymentMinutes, orgMinutes) : orgMinutes;
}

/** Which of the two limits effectiveMachineMinuteLimit took. */
export const machineMinuteLimitSource = (deploymentMinutes: number, orgMinutes: number | null | undefined): MachineMinuteLimitSource =>
    orgMinutes && orgMinutes > 0 && (deploymentMinutes <= 0 || orgMinutes < deploymentMinutes) ? 'org' : 'deployment';

const minutesOf = (seconds: number) => Math.ceil(Math.max(0, seconds) / 60);

/** Whether the org's day still holds `needSeconds` more; a limit of 0 holds everything. */
export function decideMachineMinutes(input: { spentSeconds: number; needSeconds: number; limitMinutes: number }): MachineMinutesDecision {
    if (input.limitMinutes <= 0) return { allowed: true };
    if (input.spentSeconds + input.needSeconds <= input.limitMinutes * 60) return { allowed: true };
    return { allowed: false, spentMinutes: minutesOf(input.spentSeconds), limitMinutes: input.limitMinutes, needMinutes: minutesOf(input.needSeconds) };
}

/** Whole minutes the org's day has left; null when unlimited. */
export function remainingMachineMinutes(spentSeconds: number, limitMinutes: number): number | null {
    if (limitMinutes <= 0) return null;
    return Math.max(0, limitMinutes - minutesOf(spentSeconds));
}

/** What one round of a claim reserves: its consumer's whole ceiling, the most it can hold. */
export const claimCeilingSeconds = (consumer: Consumer) => HARD_EXPIRY_MINUTES[consumer] * 60;

/** The refusal of a claim the day cannot hold: nothing was started, and waiting for room would not change it today. */
export function machineMinutesExhausted(refused: Extract<MachineMinutesDecision, { allowed: false }>): Blocked {
    return {
        status: 'blocked',
        blockers: [
            {
                kind: 'resources',
                signature: MACHINE_MINUTES_EXHAUSTED,
                message: `the organization used ${refused.spentMinutes} of its ${refused.limitMinutes} machine minutes today (UTC) and this machine may run up to ${refused.needMinutes}; nothing was started. The budget resets at 00:00 UTC (${refused.source === 'org' ? "the organization's limit in Runtime settings" : 'RUNTIME_MACHINE_MINUTES_PER_ORG_DAY'})`,
            },
        ],
    };
}
