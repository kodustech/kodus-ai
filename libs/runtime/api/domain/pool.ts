// The warm pool of an environment: how many clean machines its cell keeps
// ready, made from the environment's bake (S-52). The plan sets the default
// and the ceiling; the org admin may choose a size in Settings, never above
// the ceiling. The cell bounds it once more with its own maximum.

export interface RuntimePoolPlan {
    /** Machines kept ready when the admin chose nothing (RUNTIME_POOL_DEFAULT_SIZE). */
    defaultSize: number;
    /** The most an admin may choose (RUNTIME_POOL_MAX_SIZE). */
    maxSize: number;
}

/** The size the cell is asked for: the admin's choice or the plan's default, under the plan's ceiling. */
export function effectivePoolSize(plan: RuntimePoolPlan, setting: number | null | undefined): number {
    const wanted = setting === null || setting === undefined ? plan.defaultSize : setting;
    return Math.max(0, Math.min(wanted, plan.maxSize));
}

export class InvalidPoolSizeError extends Error {}

/** An admin's choice: a whole number from 0 to the plan's ceiling, or null for the plan's default. */
export function parsePoolSetting(plan: RuntimePoolPlan, value: unknown): number | null {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new InvalidPoolSizeError('poolSize must be a whole number from 0, or null');
    if (value > plan.maxSize) throw new InvalidPoolSizeError(`poolSize is at most ${plan.maxSize} on this plan`);
    return value;
}

// ---- When the machines are kept ready (the pool policy) ----
//
// Ready machines cost money while they wait. The size says how many; the
// policy says when: always (no policy), inside a weekly schedule, for a while
// after a pull request comes in, or both. A monthly budget stops the pool once
// the month's estimated spend reaches it. desiredPoolSize is the one rule the
// settings, the pull request trigger and the scheduler all apply.

export const POOL_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type PoolWeekday = (typeof POOL_WEEKDAYS)[number];

export interface PoolSchedule {
    /** IANA time zone the hours are read in (America/Sao_Paulo). */
    timezone: string;
    days: PoolWeekday[];
    /** "HH:MM", 24 h. An end before the start runs past midnight into the next day. */
    start: string;
    end: string;
}

export interface PoolPolicy {
    /** Ready only inside these hours. */
    schedule?: PoolSchedule;
    /** Ready for this long after a pull request opens or gets a push (and inside the schedule, if any, as well). */
    onPullRequest?: { idleMinutes: number };
    /** Stop keeping machines once this month's estimated pool spend reaches it. */
    monthlyBudgetUsd?: number;
}

/** The pool's estimated use this month: machine-minutes kept ready, counted by the scheduler. */
export interface PoolUsage {
    /** "YYYY-MM", UTC. */
    month: string;
    machineMinutes: number;
    /** The last time the count moved forward. */
    countedAt: string;
}

export type PoolReason = 'off' | 'always' | 'schedule' | 'outside_schedule' | 'pull_request' | 'idle' | 'budget';

export interface PoolDecision {
    size: number;
    reason: PoolReason;
}

export const POOL_LIMITS = { idleMinutesMin: 10, idleMinutesMax: 24 * 60, budgetMaxUsd: 100_000 } as const;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (hhmm: string) => {
    const m = HHMM.exec(hhmm)!;
    return Number(m[1]) * 60 + Number(m[2]);
};

/** The weekday and minute of the day at `now` in `timezone`. */
function localTime(now: Date, timezone: string): { day: PoolWeekday; minute: number } {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const day = get('weekday').toLowerCase().slice(0, 3) as PoolWeekday;
    return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Whether `now` falls inside the schedule. A window past midnight belongs to the day it starts on. */
export function insideSchedule(schedule: PoolSchedule, now: Date): boolean {
    const { day, minute } = localTime(now, schedule.timezone);
    const start = minutesOf(schedule.start);
    const end = minutesOf(schedule.end);
    const prev = POOL_WEEKDAYS[(POOL_WEEKDAYS.indexOf(day) + 6) % 7];
    if (start < end) return schedule.days.includes(day) && minute >= start && minute < end;
    // Past midnight: the evening of a listed day, or the early hours after one.
    return (schedule.days.includes(day) && minute >= start) || (schedule.days.includes(prev) && minute < end);
}

/** Hours a week the schedule keeps machines ready. */
export function scheduleHoursPerWeek(schedule: PoolSchedule): number {
    const start = minutesOf(schedule.start);
    const end = minutesOf(schedule.end);
    const perDay = start < end ? end - start : 24 * 60 - start + end;
    return (perDay * schedule.days.length) / 60;
}

const HOURS_PER_MONTH = (365.25 * 24) / 12;

/**
 * How many machines the cell should keep ready now, and why. With no policy
 * the size holds all the time; a budget spent turns the pool off whatever
 * else says.
 */
export function desiredPoolSize(args: {
    size: number;
    policy?: PoolPolicy | null;
    now: Date;
    lastPullRequestAt?: string | null;
    spentUsd?: number;
}): PoolDecision {
    const { size, policy, now } = args;
    if (size <= 0) return { size: 0, reason: 'off' };
    if (policy?.monthlyBudgetUsd !== undefined && (args.spentUsd ?? 0) >= policy.monthlyBudgetUsd) return { size: 0, reason: 'budget' };
    if (!policy?.schedule && !policy?.onPullRequest) return { size, reason: 'always' };
    const inHours = policy.schedule ? insideSchedule(policy.schedule, now) : undefined;
    if (inHours === true) return { size, reason: 'schedule' };
    if (policy.onPullRequest && args.lastPullRequestAt) {
        const since = now.getTime() - Date.parse(args.lastPullRequestAt);
        if (since >= 0 && since < policy.onPullRequest.idleMinutes * 60_000) return { size, reason: 'pull_request' };
    }
    return { size: 0, reason: inHours === false ? 'outside_schedule' : 'idle' };
}

/**
 * The most the pool can cost in a month at list price: the size times the
 * hours it may be ready. With only the pull request trigger the hours depend
 * on activity, so `hours` is null and the caller says so.
 */
export function poolMonthlyEstimate(size: number, policy: PoolPolicy | null | undefined, usdPerMachineHour: number): { hours: number | null; usd: number | null } {
    if (size <= 0) return { hours: 0, usd: 0 };
    if (policy?.schedule) {
        const hours = (scheduleHoursPerWeek(policy.schedule) * 365.25) / 12 / 7;
        return { hours: Math.round(hours), usd: round2(size * hours * usdPerMachineHour) };
    }
    if (policy?.onPullRequest) return { hours: null, usd: null };
    return { hours: Math.round(HOURS_PER_MONTH), usd: round2(size * HOURS_PER_MONTH * usdPerMachineHour) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The month's usage moved forward to `now`: `applied` machines kept ready since the last count. */
export function countPoolUsage(prev: PoolUsage | null | undefined, applied: number, now: Date): PoolUsage {
    const month = now.toISOString().slice(0, 7);
    if (!prev || prev.month !== month) return { month, machineMinutes: 0, countedAt: now.toISOString() };
    const minutes = Math.max(0, (now.getTime() - Date.parse(prev.countedAt)) / 60_000);
    // A scheduler that was down does not bill the gap: at most one tick's worth (15 min) per count.
    return { month, machineMinutes: prev.machineMinutes + applied * Math.min(minutes, 15), countedAt: now.toISOString() };
}

export const poolSpentUsd = (usage: PoolUsage | null | undefined, now: Date, usdPerMachineHour: number) =>
    usage && usage.month === now.toISOString().slice(0, 7) ? round2((usage.machineMinutes / 60) * usdPerMachineHour) : 0;

export class InvalidPoolPolicyError extends Error {}

/** An admin's policy, checked: null turns it off (always ready at the size). */
export function parsePoolPolicy(value: unknown): PoolPolicy | null {
    if (value === null) return null;
    const bad = (why: string): never => {
        throw new InvalidPoolPolicyError(`poolPolicy: ${why}`);
    };
    if (!value || typeof value !== 'object' || Array.isArray(value)) bad('must be an object or null');
    const v = value as Record<string, unknown>;
    const unknownKey = Object.keys(v).find((k) => !['schedule', 'onPullRequest', 'monthlyBudgetUsd'].includes(k));
    if (unknownKey) bad(`unknown field ${unknownKey}`);
    const out: PoolPolicy = {};
    if (v.schedule !== undefined) {
        const s = v.schedule as Record<string, unknown>;
        if (!s || typeof s !== 'object') bad('schedule must be an object');
        const extra = Object.keys(s).find((k) => !['timezone', 'days', 'start', 'end'].includes(k));
        if (extra) bad(`schedule: unknown field ${extra}`);
        if (typeof s.timezone !== 'string' || s.timezone.length > 64) bad('schedule.timezone must be an IANA time zone');
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: s.timezone as string });
        } catch {
            bad(`schedule.timezone ${JSON.stringify(s.timezone)} is not a time zone`);
        }
        if (!Array.isArray(s.days) || !s.days.length || s.days.some((d) => !(POOL_WEEKDAYS as readonly unknown[]).includes(d))) bad('schedule.days must list days from mon to sun');
        if (typeof s.start !== 'string' || !HHMM.test(s.start) || typeof s.end !== 'string' || !HHMM.test(s.end)) bad('schedule.start and end are HH:MM');
        if (s.start === s.end) bad('schedule.start and end are the same time; leave the schedule out to keep machines ready all day');
        out.schedule = { timezone: s.timezone as string, days: POOL_WEEKDAYS.filter((d) => (s.days as string[]).includes(d)), start: s.start as string, end: s.end as string };
    }
    if (v.onPullRequest !== undefined) {
        const p = v.onPullRequest as Record<string, unknown>;
        const m = p && typeof p === 'object' ? p.idleMinutes : undefined;
        if (!p || typeof p !== 'object' || Object.keys(p).some((k) => k !== 'idleMinutes')) bad('onPullRequest must be { idleMinutes }');
        if (typeof m !== 'number' || !Number.isInteger(m) || m < POOL_LIMITS.idleMinutesMin || m > POOL_LIMITS.idleMinutesMax) {
            bad(`onPullRequest.idleMinutes is a whole number from ${POOL_LIMITS.idleMinutesMin} to ${POOL_LIMITS.idleMinutesMax}`);
        }
        out.onPullRequest = { idleMinutes: m as number };
    }
    if (v.monthlyBudgetUsd !== undefined) {
        const b = v.monthlyBudgetUsd;
        if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > POOL_LIMITS.budgetMaxUsd) bad(`monthlyBudgetUsd is more than 0 and at most ${POOL_LIMITS.budgetMaxUsd}`);
        out.monthlyBudgetUsd = round2(b as number);
    }
    return out;
}
