// Spec distribution (docs/runtime/e2e-suites.md section 6): longest-processing-
// time-first onto N bins by stored durations, with the fallbacks of the design.
// Pure; the engine calls it with the spec list at the PR sha and the stats store.

export interface SuiteSpecFile {
    path: string;
    sizeBytes: number;
}

/** What `runtime_suite_spec_stats` says about a spec; only the median is read here. */
export interface SpecStat {
    p50Ms: number;
}
export type SpecStats = Readonly<Record<string, SpecStat>>;

export interface SpecBin {
    specs: string[];
    /** Milliseconds on a duration basis, bytes on a size basis. */
    weight: number;
}

export interface BalancedPlan {
    basis: 'duration' | 'size';
    bins: SpecBin[];
}

/** Section 6: a shard is worth its boot and build only past this much work. */
export const TARGET_SHARD_MS = 8 * 60_000;

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function knownAverage(specs: readonly SuiteSpecFile[], stats: SpecStats): number | undefined {
    const known = specs.map((s) => stats[s.path]?.p50Ms).filter((n): n is number => typeof n === 'number');
    return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0) / known.length;
}

/** The estimated time of each spec: its stored median, else the average of the known ones; undefined with none known. */
export function estimateDurations(specs: readonly SuiteSpecFile[], stats: SpecStats): Map<string, number> | undefined {
    const avg = knownAverage(specs, stats);
    if (avg === undefined) return undefined;
    return new Map(specs.map((s) => [s.path, stats[s.path]?.p50Ms ?? avg]));
}

export function estimateTotalMs(specs: readonly SuiteSpecFile[], stats: SpecStats): number | undefined {
    const d = estimateDurations(specs, stats);
    if (!d) return undefined;
    return Math.round([...d.values()].reduce((a, b) => a + b, 0));
}

export function balanceSpecs(specs: readonly SuiteSpecFile[], stats: SpecStats, binCount: number): BalancedPlan {
    const n = Math.max(1, Math.floor(binCount));
    const bins: SpecBin[] = Array.from({ length: n }, () => ({ specs: [], weight: 0 }));
    const durations = estimateDurations(specs, stats);

    if (durations) {
        const ordered = [...specs].sort((a, b) => durations.get(b.path)! - durations.get(a.path)! || byPath(a, b));
        for (const s of ordered) {
            let lightest = 0;
            for (let i = 1; i < n; i++) if (bins[i].weight < bins[lightest].weight) lightest = i;
            bins[lightest].specs.push(s.path);
            bins[lightest].weight += durations.get(s.path)!;
        }
        return { basis: 'duration', bins };
    }

    // No duration yet (the first run): by file size, dealt round-robin in sorted order.
    const ordered = [...specs].sort((a, b) => b.sizeBytes - a.sizeBytes || byPath(a, b));
    ordered.forEach((s, i) => {
        const bin = bins[i % n];
        bin.specs.push(s.path);
        bin.weight += s.sizeBytes;
    });
    return { basis: 'size', bins };
}

export interface ShardCountInput {
    /** Estimated work, from `estimateTotalMs`; undefined when no duration is stored. */
    totalMs: number | undefined;
    /** `suite.shards`, a ceiling. */
    maxShards: number;
    /** How many hosts the pool can start now. */
    headroom: number;
    specCount: number;
    targetShardMs?: number;
}

/** N = clamp(ceil(total / target), 1, suite.shards, headroom), and never more than the specs. */
export function shardCount(i: ShardCountInput): number {
    const ceiling = Math.max(1, Math.min(i.maxShards, i.headroom, Math.max(1, i.specCount)));
    if (i.totalMs === undefined) return ceiling;
    const wanted = Math.ceil(i.totalMs / (i.targetShardMs ?? TARGET_SHARD_MS));
    return Math.max(1, Math.min(wanted, ceiling));
}

/**
 * What a spec costs in a shard beyond its own `durationMs`: the runner's per-spec start (Cypress opens the browser for every
 * spec, slowly under gVisor). `wallMs` runs from the shard's claim ready to its last result, `durationsMs` are the specs that
 * reported in it. Stored with each spec's duration, so the stored time is the wall time a spec costs a shard.
 */
export function perSpecOverheadMs(i: { wallMs: number; durationsMs: readonly number[] }): number {
    if (i.durationsMs.length === 0) return 0;
    const sum = i.durationsMs.reduce((a, b) => a + b, 0);
    return Math.max(0, Math.round((i.wallMs - sum) / i.durationsMs.length));
}

/** The work one shard is planned to take: the target, cut to 80% of the shard's cap and of the time left to the suite's deadline, so a plan never promises a shard more than it may use. */
export function shardTargetMs(i: { shardTimeoutMs: number; timeLeftMs?: number }): number {
    const room = Math.min(i.shardTimeoutMs, i.timeLeftMs ?? Infinity);
    return Math.max(1, Math.min(TARGET_SHARD_MS, Math.floor(room * 0.8)));
}
