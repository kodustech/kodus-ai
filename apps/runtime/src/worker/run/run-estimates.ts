import type { RunProjectionReader, RuntimeRunProgress } from '@libs/runtime/run';

// What booting and applying usually take on an environment, for the PR
// comment while a long phase runs ("usually ~8 min"): the median of the
// environment's last Runs that booted both sides. The workflow reads it in
// a step, so a resumed Run shows the same estimate.

export type PhaseEstimates = NonNullable<RuntimeRunProgress['estimates']>;

/** How many of the environment's recent Runs the estimate is the median of. */
export const ESTIMATE_RUNS = 5;
/** The progress schema's bound on a phase. */
const MAX_ESTIMATE_MS = 86_400_000;
/** How many recent Runs are read to find them (some never booted both sides). */
const SCANNED_RUNS = 20;

export function median(xs: readonly number[]): number | undefined {
    if (!xs.length) return undefined;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** The estimates for this Run from its environment's last Runs; undefined when none booted both sides. */
export async function phaseEstimates(
    projection: Pick<RunProjectionReader, 'list'>,
    run: { runId: string; organizationId: string; environmentId: string },
): Promise<PhaseEstimates | undefined> {
    const recent = await projection.list({ organizationId: run.organizationId, environmentId: run.environmentId, limit: SCANNED_RUNS });
    const timed = recent
        .filter((r) => r.runId !== run.runId && r.organizationId === run.organizationId && r.environmentId === run.environmentId && r.phaseMs)
        .slice(0, ESTIMATE_RUNS)
        .map((r) => r.phaseMs!);
    if (!timed.length) return undefined;
    const ms = (xs: number[]) => {
        const m = median(xs.filter((x) => Number.isFinite(x) && x >= 0));
        return m === undefined ? undefined : Math.min(m, MAX_ESTIMATE_MS);
    };
    const boot = ms(timed.map((p) => p.boot));
    const apply = ms(timed.map((p) => p.apply));
    return { ...(boot !== undefined ? { bootMs: boot } : {}), ...(apply !== undefined ? { applyMs: apply } : {}) };
}
