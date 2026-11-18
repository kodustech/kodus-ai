import type { RuntimeSpeed, SpeedStat } from "../contracts";

/** A duration as the Speed card prints it: 800 ms, 9.0 s, 4 min 12 s, 1 h 6 min. */
export function formatSpeedMs(ms: number): string {
    if (ms < 1_000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
    const totalS = Math.round(ms / 1_000);
    if (totalS < 3_600)
        return `${Math.floor(totalS / 60)} min ${totalS % 60} s`;
    const totalMin = Math.round(totalS / 60);
    return `${Math.floor(totalMin / 60)} h ${totalMin % 60} min`;
}

/** One percentile of a bucket, or "too few Runs" when the bucket has under the minimum. */
export function speedValue(stat: SpeedStat, key: "p50Ms" | "p95Ms"): string {
    const v = stat[key];
    return stat.tooFew || v === null ? "too few Runs" : formatSpeedMs(v);
}

/**
 * The card's one sentence: the median Run's time to a verdict, and how much
 * sooner warm-pool Runs are ready than cold boots (both p50), only when each
 * bucket has enough Runs to say it.
 */
export function speedTakeaway(speed: RuntimeSpeed): string {
    const verdict = speed.all.verdict;
    if (verdict.tooFew || verdict.p50Ms === null)
        return `Too few Runs in the last ${speed.windowDays} days to quote a speed: ${verdict.n} of the ${speed.minRuns} needed.`;
    const first = `Half the Runs reach a verdict within ${formatSpeedMs(verdict.p50Ms)}`;
    const warm = speed.bySource.warm_pool.ready;
    const cold = speed.bySource.cold_boot.ready;
    if (
        warm.tooFew ||
        cold.tooFew ||
        warm.p50Ms === null ||
        cold.p50Ms === null
    )
        return `${first}; too few warm-pool and cold-boot Runs yet to compare them.`;
    const diff = cold.p50Ms - warm.p50Ms;
    if (diff > 0)
        return `${first}; warm-pool Runs are ready ${formatSpeedMs(diff)} faster than cold boots.`;
    if (diff < 0)
        return `${first}; warm-pool Runs are ready ${formatSpeedMs(-diff)} slower than cold boots.`;
    return `${first}; warm-pool Runs are ready as fast as cold boots.`;
}
