import type { RuntimeMachineMinutesToday } from "../contracts";

/** The hub's refusal of a claim the org's day cannot hold (libs/runtime/environment/machine-minutes.ts). */
export const MACHINE_MINUTES_EXHAUSTED = "machine_minutes_exhausted";

const WAIT_WORDS =
    "Your organization used all of today's machine minutes. New setups and Runs wait until they reset at 00:00 UTC; nothing in the repository needs to change.";

/** The plain words of the machine-minutes blocker, wherever a blocker renders; undefined for any other. */
export const machineMinutesBlockerWords = (
    b: { signature: string } | undefined,
) => (b?.signature === MACHINE_MINUTES_EXHAUSTED ? WAIT_WORDS : undefined);

const untilReset = (resetsAt: string, now: Date) => {
    const minutes = Math.max(
        0,
        Math.ceil((Date.parse(resetsAt) - now.getTime()) / 60_000),
    );
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
};

/** What the settings screen says about today's machine time. */
export const machineMinutesSummary = (
    today: RuntimeMachineMinutesToday,
    now: Date = new Date(),
) => ({
    usedMinutes: today.usedMinutes,
    limitMinutes: today.limitMinutes,
    /** Reserved by machines still running: they may use it, and it already counts against the limit. */
    heldByRunningMinutes: Math.max(
        0,
        today.committedMinutes - today.usedMinutes,
    ),
    runningMachines: today.openRounds,
    exhausted: today.remainingMinutes === 0,
    remainingMinutes: today.remainingMinutes,
    resetsIn: untilReset(today.resetsAt, now),
    waitWords: WAIT_WORDS,
});

const min = (n: number) => `${n.toLocaleString("en-US")} min`;

/**
 * The API's ceiling on the org's own limit (MAX_ORG_MACHINE_MINUTES_PER_DAY in
 * libs/runtime/environment/machine-minutes.ts); kept here so the web imports no runtime value from @libs.
 */
export const MAX_ORG_MACHINE_MINUTES_PER_DAY = 14_400_000;

type Limits = Pick<
    RuntimeMachineMinutesToday,
    | "limitMinutes"
    | "deploymentLimitMinutes"
    | "orgLimitMinutes"
    | "limitSource"
>;

/** Which daily limit holds the org today (the lower of the deployment's and the org's own), in plain words. */
export const machineMinuteLimitWords = (t: Limits): string => {
    if (t.limitMinutes === null)
        return "No daily limit: neither this deployment nor your organization sets one.";
    if (t.limitSource === "org")
        return t.deploymentLimitMinutes !== null
            ? `Your organization's limit of ${min(t.limitMinutes)} a day applies (the deployment allows up to ${min(t.deploymentLimitMinutes)}).`
            : `Your organization's limit of ${min(t.limitMinutes)} a day applies.`;
    return t.orgLimitMinutes !== null
        ? `The deployment's limit of ${min(t.limitMinutes)} a day applies: your organization's ${min(t.orgLimitMinutes)} is not below it.`
        : `The deployment's limit of ${min(t.limitMinutes)} a day applies. Set your organization's own to hold it to less.`;
};

/**
 * The org's own limit as typed: a positive whole number of minutes, at most the deployment's
 * (the org's limit only lowers it). Empty = nothing to save; clearing the limit is its own action.
 */
export const orgMachineMinuteLimitDraft = (
    draft: string,
    deploymentLimitMinutes: number | null,
): { minutesPerDay: number | null; error?: string } => {
    const text = draft.trim();
    if (text === "") return { minutesPerDay: null };
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1)
        return {
            minutesPerDay: null,
            error: "Enter a whole number of minutes, 1 or more.",
        };
    if (deploymentLimitMinutes !== null && n > deploymentLimitMinutes)
        return {
            minutesPerDay: null,
            error: `This deployment allows up to ${min(deploymentLimitMinutes)} a day; your organization's limit can only lower it.`,
        };
    if (n > MAX_ORG_MACHINE_MINUTES_PER_DAY)
        return {
            minutesPerDay: null,
            error: `Enter at most ${min(MAX_ORG_MACHINE_MINUTES_PER_DAY)} a day.`,
        };
    return { minutesPerDay: n };
};
