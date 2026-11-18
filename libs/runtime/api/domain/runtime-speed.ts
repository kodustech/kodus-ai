/**
 * The Speed card of the Health screen (docs/runtime/observability.md, "Speed"):
 * how long the org's Runs take, from data the Runtime already records, so the
 * numbers can be quoted. Three durations per Run, each from the request:
 *   - verdict: requested_at until finished_at, for a Run that ended in a verdict;
 *   - ready: requested_at until both sides had executed their first probe
 *     (the later of the two step.started events of a probe step);
 *   - queue: requested_at until started_at (a worker took the Run).
 * Percentiles are nearest-rank; a bucket of fewer than SPEED_MIN_RUNS Runs has
 * no number, only its n. Pure: the reader hands the rows.
 */

export const SPEED_WINDOW_DAYS = [7, 30] as const;
export type SpeedWindowDays = (typeof SPEED_WINDOW_DAYS)[number];
/** Under this many Runs a bucket says "too few Runs" instead of a percentile. */
export const SPEED_MIN_RUNS = 20;

/** The states a Run ends in with a verdict; every other end state is counted as excluded, by reason. */
const VERDICT_STATES = new Set(['no_regressions', 'regression', 'partly_tested', 'could_not_boot', 'nothing_to_test']);
const CANCELLED_STATES = new Set(['cancelled', 'superseded']);
const NO_VERDICT_STATES = new Set(['errored', 'timed_out', 'halted']);

export const MACHINE_SOURCES = ['warm_pool', 'cold_boot', 'baked', 'unknown'] as const;
export type MachineSource = (typeof MACHINE_SOURCES)[number];
export const MACHINE_HOSTS = ['kodus_cloud', 'own_host', 'unknown'] as const;
export type MachineHost = (typeof MACHINE_HOSTS)[number];

/** One Run of the window, as the reader reads it. */
export interface SpeedRunRow {
    runId: string;
    environmentId: string | null;
    state: string;
    requestedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    /** When each side's first probe step started (runtime_run_events step.started with a probeId). */
    firstProbeAt: { base?: string | null; pr?: string | null };
    /** runtime_claims.start_source of each ready claim of the Run (cold, pool, bake; null when the cell did not say). */
    sideStarts: (string | null)[];
    /** runtime_cells.owner of the cell of each ready claim (kodus, customer). */
    sideOwners: (string | null)[];
}

export interface SpeedStat {
    n: number;
    /** True under SPEED_MIN_RUNS: p50Ms and p95Ms are then null. */
    tooFew: boolean;
    p50Ms: number | null;
    p95Ms: number | null;
}
export interface SpeedMetrics {
    verdict: SpeedStat;
    ready: SpeedStat;
    queue: SpeedStat;
}
export interface RuntimeSpeed {
    windowDays: SpeedWindowDays;
    since: string;
    until: string;
    minRuns: number;
    /** Runs requested in the window. */
    considered: number;
    /** Runs that ended in a verdict: the population of every number. */
    counted: number;
    excluded: { cancelledOrSuperseded: number; skipped: number; unfinished: number; noVerdict: number };
    /** Counted Runs left out of one number because a timestamp it needs is absent (or earlier than the request). */
    missing: { verdict: number; ready: number; queue: number };
    /** The reader hit its row cap: the oldest Runs of the window are not in the numbers. */
    truncated: boolean;
    all: SpeedMetrics;
    bySource: Record<MachineSource, SpeedMetrics>;
    byHost: Record<MachineHost, SpeedMetrics>;
    byEnvironment: Array<{ environmentId: string | null } & SpeedMetrics>;
}

/** The nearest-rank percentile: the value at rank ceil(p/100 * n) of the sorted values; null for none. */
export function nearestRank(values: readonly number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[Math.min(rank, sorted.length) - 1];
}

/** How the Run's machines came to be: warm pool only when every side came from the pool, cold boot when any side booted cold. */
export function machineSourceOf(starts: readonly (string | null)[]): MachineSource {
    if (starts.length === 0 || starts.some((s) => s === null)) return 'unknown';
    if (starts.includes('cold')) return 'cold_boot';
    if (starts.every((s) => s === 'pool')) return 'warm_pool';
    return starts.every((s) => s === 'pool' || s === 'bake') ? 'baked' : 'unknown';
}

/** Where the Run's machines ran: own host when any side ran on a customer cell, Kodus cloud when every side ran on a Kodus cell. */
export function machineHostOf(owners: readonly (string | null)[]): MachineHost {
    if (owners.includes('customer')) return 'own_host';
    if (owners.length > 0 && owners.every((o) => o === 'kodus')) return 'kodus_cloud';
    return 'unknown';
}

interface Durations {
    verdict: number | null;
    ready: number | null;
    queue: number | null;
}

const since = (from: number, to: string | null | undefined): number | null => {
    if (!to) return null;
    const t = Date.parse(to);
    return Number.isFinite(t) && t >= from ? t - from : null;
};

function durationsOf(row: SpeedRunRow): Durations {
    const requested = row.requestedAt ? Date.parse(row.requestedAt) : NaN;
    if (!Number.isFinite(requested)) return { verdict: null, ready: null, queue: null };
    const base = since(requested, row.firstProbeAt.base);
    const pr = since(requested, row.firstProbeAt.pr);
    return {
        verdict: since(requested, row.finishedAt),
        ready: base === null || pr === null ? null : Math.max(base, pr),
        queue: since(requested, row.startedAt),
    };
}

function statOf(values: number[]): SpeedStat {
    const tooFew = values.length < SPEED_MIN_RUNS;
    return { n: values.length, tooFew, p50Ms: tooFew ? null : nearestRank(values, 50), p95Ms: tooFew ? null : nearestRank(values, 95) };
}

function metricsOf(durations: Durations[]): SpeedMetrics {
    const of = (k: keyof Durations) => durations.map((d) => d[k]).filter((v): v is number => v !== null);
    return { verdict: statOf(of('verdict')), ready: statOf(of('ready')), queue: statOf(of('queue')) };
}

const groupBy = <K extends string | null>(items: Array<{ key: K; d: Durations }>) => {
    const m = new Map<K, Durations[]>();
    for (const { key, d } of items) m.set(key, [...(m.get(key) ?? []), d]);
    return m;
};

export function buildRuntimeSpeed(input: { rows: SpeedRunRow[]; windowDays: SpeedWindowDays; now: Date; truncated?: boolean }): RuntimeSpeed {
    const excluded = { cancelledOrSuperseded: 0, skipped: 0, unfinished: 0, noVerdict: 0 };
    const counted: Array<{ row: SpeedRunRow; d: Durations }> = [];
    for (const row of input.rows) {
        if (CANCELLED_STATES.has(row.state)) excluded.cancelledOrSuperseded++;
        else if (row.state === 'skipped') excluded.skipped++;
        else if (NO_VERDICT_STATES.has(row.state)) excluded.noVerdict++;
        else if (!VERDICT_STATES.has(row.state)) excluded.unfinished++;
        else counted.push({ row, d: durationsOf(row) });
    }
    const missing = {
        verdict: counted.filter((c) => c.d.verdict === null).length,
        ready: counted.filter((c) => c.d.ready === null).length,
        queue: counted.filter((c) => c.d.queue === null).length,
    };
    const bySourceMap = groupBy(counted.map((c) => ({ key: machineSourceOf(c.row.sideStarts), d: c.d })));
    const byHostMap = groupBy(counted.map((c) => ({ key: machineHostOf(c.row.sideOwners), d: c.d })));
    const byEnvMap = groupBy(counted.map((c) => ({ key: c.row.environmentId, d: c.d })));
    return {
        windowDays: input.windowDays,
        since: new Date(input.now.getTime() - input.windowDays * 86_400_000).toISOString(),
        until: input.now.toISOString(),
        minRuns: SPEED_MIN_RUNS,
        considered: input.rows.length,
        counted: counted.length,
        excluded,
        missing,
        truncated: input.truncated ?? false,
        all: metricsOf(counted.map((c) => c.d)),
        bySource: Object.fromEntries(MACHINE_SOURCES.map((s) => [s, metricsOf(bySourceMap.get(s) ?? [])])) as Record<MachineSource, SpeedMetrics>,
        byHost: Object.fromEntries(MACHINE_HOSTS.map((h) => [h, metricsOf(byHostMap.get(h) ?? [])])) as Record<MachineHost, SpeedMetrics>,
        byEnvironment: [...byEnvMap.entries()]
            .map(([environmentId, ds]) => ({ environmentId, ...metricsOf(ds) }))
            .sort((a, b) => b.verdict.n - a.verdict.n || String(a.environmentId ?? '￿').localeCompare(String(b.environmentId ?? '￿')))
            .slice(0, 20),
    };
}
