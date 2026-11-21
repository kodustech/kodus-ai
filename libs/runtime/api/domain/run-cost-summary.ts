import type { RuntimeRunCost } from './run-cost';

/**
 * What a set of Runs cost (H5: the cost per Run fits the price).
 *
 * A part the cell or the price list could not price is `null` in a Run's
 * cost, never zero. Adding those as zero makes the cost per Run look lower
 * than it is and lets H5 pass unearned, so this summary never does: the sum
 * is of what was priced, the unpriced parts are counted beside it, and a
 * per-Run figure is given only over the Runs priced in full.
 */
export interface RunCostSummary {
    runs: number;
    /** Runs whose machines and LLM were both priced. */
    completeRuns: number;
    /** The sum of every priced part. A lower bound while `unpricedParts.total` is above zero. */
    pricedUsd: number;
    /** Parts with no price: one per Run whose machines, or whose LLM, could not be priced. */
    unpricedParts: { machines: number; llm: number; total: number };
    /** The cost per Run, over the Runs priced in full only; null when none was. */
    perCompleteRun: { medianUsd: number; maxUsd: number } | null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function summarizeRunCosts(costs: readonly RuntimeRunCost[]): RunCostSummary {
    let pricedUsd = 0;
    let machines = 0;
    let llm = 0;
    const complete: number[] = [];
    for (const c of costs) {
        // totalUsd is already the sum of the priced parts of one Run.
        pricedUsd += c.totalUsd ?? 0;
        if (c.machines.usd === null) machines++;
        if (c.llm.usd === null) llm++;
        if (c.complete && c.totalUsd !== null) complete.push(c.totalUsd);
    }
    complete.sort((a, b) => a - b);
    const mid = Math.floor(complete.length / 2);
    return {
        runs: costs.length,
        completeRuns: complete.length,
        pricedUsd: round6(pricedUsd),
        unpricedParts: { machines, llm, total: machines + llm },
        perCompleteRun:
            complete.length === 0
                ? null
                : {
                      medianUsd: round6(complete.length % 2 ? complete[mid] : (complete[mid - 1] + complete[mid]) / 2),
                      maxUsd: round6(complete[complete.length - 1]),
                  },
    };
}

/** One line for a report: an exact total only when every part was priced. */
export function formatRunCostSummary(s: RunCostSummary): string {
    const usd = `US$ ${s.pricedUsd.toFixed(2)}`;
    if (s.runs === 0) return 'no Runs';
    if (s.unpricedParts.total === 0) return `${usd} over ${s.runs} Runs`;
    return `≥ ${usd} + ${s.unpricedParts.total} unpriced parts (${s.unpricedParts.machines} machine, ${s.unpricedParts.llm} LLM) over ${s.runs} Runs; ${s.completeRuns} priced in full`;
}
