import type { RuntimeRunCost } from '../domain/run-cost';
import { formatRunCostSummary, summarizeRunCosts } from '../domain/run-cost-summary';

const run = (machinesUsd: number | null, llmUsd: number | null, byokUsd = 0): RuntimeRunCost =>
    ({
        machines: { usd: machinesUsd },
        llm: { usd: llmUsd, customerUsd: byokUsd },
        // As estimateRunCost: the sum of what was priced, null when nothing was.
        totalUsd: machinesUsd === null && llmUsd === null ? null : (machinesUsd ?? 0) + (llmUsd ?? 0),
        complete: machinesUsd !== null && llmUsd !== null,
    }) as RuntimeRunCost;

describe('summarizeRunCosts (H5)', () => {
    it('gives an exact total and a per-Run cost when every part was priced', () => {
        const s = summarizeRunCosts([run(0.1, 0.3), run(0.2, 0.2), run(0.1, 0.8)]);
        expect(s).toEqual({ runs: 3, completeRuns: 3, pricedUsd: 1.7, unpricedParts: { machines: 0, llm: 0, total: 0 }, perCompleteRun: { medianUsd: 0.4, maxUsd: 0.9, medianMachinesUsd: 0.1, medianLlmManagedUsd: 0.3, medianLlmByokUsd: 0 } });
        expect(formatRunCostSummary(s)).toBe('US$ 1.70 over 3 Runs');
    });

    it('never counts an unpriced part as zero: the total is a lower bound and says how many parts are missing', () => {
        const s = summarizeRunCosts([run(0.1, 0.3), run(null, 0.2), run(0.1, null), run(null, null)]);
        expect(s.pricedUsd).toBe(0.7);
        expect(s.unpricedParts).toEqual({ machines: 2, llm: 2, total: 4 });
        // A Run with a missing part has no per-Run cost: it would read as cheap.
        expect(s.completeRuns).toBe(1);
        expect(s.perCompleteRun).toEqual({ medianUsd: 0.4, maxUsd: 0.4, medianMachinesUsd: 0.1, medianLlmManagedUsd: 0.3, medianLlmByokUsd: 0 });
        expect(formatRunCostSummary(s)).toBe('≥ US$ 0.70 + 4 unpriced parts (2 machine, 2 LLM) over 4 Runs; 1 priced in full');
    });

    it('has no per-Run cost when no Run was priced in full', () => {
        const s = summarizeRunCosts([run(null, 0.2), run(null, null)]);
        expect(s.perCompleteRun).toBeNull();
        expect(formatRunCostSummary(summarizeRunCosts([]))).toBe('no Runs');
    });

    it('splits the per-Run cost into machines, managed LLM and BYOK LLM, each the median over the Runs priced in full', () => {
        // LLM 0.30 of which 0.10 is the org's own key; 0.20 all managed; 0.80 of which 0.60 BYOK.
        const s = summarizeRunCosts([run(0.1, 0.3, 0.1), run(0.2, 0.2), run(0.1, 0.8, 0.6), run(null, 5, 5)]);
        expect(s.perCompleteRun).toMatchObject({ medianMachinesUsd: 0.1, medianLlmManagedUsd: 0.2, medianLlmByokUsd: 0.1 });
    });
});
