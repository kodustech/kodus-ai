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
    perCompleteRun: {
        medianUsd: number;
        maxUsd: number;
        /** The median of each part over the same Runs; they need not add up to medianUsd. */
        medianMachinesUsd: number;
        medianLlmManagedUsd: number;
        medianLlmByokUsd: number;
    } | null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return round6(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

export function summarizeRunCosts(costs: readonly RuntimeRunCost[]): RunCostSummary {
    let pricedUsd = 0;
    let machines = 0;
    let llm = 0;
    const complete: number[] = [];
    const parts: Array<{ machines: number; managed: number; byok: number }> = [];
    for (const c of costs) {
        // totalUsd is already the sum of the priced parts of one Run.
        pricedUsd += c.totalUsd ?? 0;
        if (c.machines.usd === null) machines++;
        if (c.llm.usd === null) llm++;
        if (c.complete && c.totalUsd !== null) {
            complete.push(c.totalUsd);
            const byok = c.llm.customerUsd ?? 0;
            parts.push({ machines: c.machines.usd ?? 0, managed: (c.llm.usd ?? 0) - byok, byok });
        }
    }
    complete.sort((a, b) => a - b);
    return {
        runs: costs.length,
        completeRuns: complete.length,
        pricedUsd: round6(pricedUsd),
        unpricedParts: { machines, llm, total: machines + llm },
        perCompleteRun:
            complete.length === 0
                ? null
                : {
                      medianUsd: median(complete),
                      maxUsd: round6(complete[complete.length - 1]),
                      medianMachinesUsd: median(parts.map((p) => p.machines)),
                      medianLlmManagedUsd: median(parts.map((p) => p.managed)),
                      medianLlmByokUsd: median(parts.map((p) => p.byok)),
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
