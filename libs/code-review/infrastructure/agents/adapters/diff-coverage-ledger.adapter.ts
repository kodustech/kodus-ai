/**
 * code-review (domain) — adapter from the diff-hunk coverage ledger to the
 * generic agent-harness ProgressLedger port.
 *
 * This is the hexagonal seam in action: agent-harness defines the PORT
 * (ProgressLedger), code-review provides the ADAPTER. Dependency points the
 * correct way (domain -> core). The CompletionGatePolicy stays domain-agnostic;
 * the diff/hunk specifics live here, reusing the battle-tested range-based
 * coverage-ledger (a narrow read does NOT cover a hunk it missed).
 */
import type {
    ProgressLedger,
    ProgressSummary as CoreCoverageSummary,
} from '@libs/agent-harness/domain/contracts/progress.contract';

import {
    buildCoverageLedger,
    formatCoverageDebt,
    getCoverageSummary,
    isCoverageSatisfied,
    markCoverageFromToolCall,
    TIERED_TOTAL_COVERAGE_THRESHOLD,
    type CoverageSummary,
    type CoverageTarget,
    type CoverageTier,
} from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';

export interface DiffCoverageLedgerParams {
    changedFiles?: any[];
    /** Tier map (critical/warm/optional). When omitted, flat coverage. */
    fileTiers?: Map<string, CoverageTier>;
}

export class DiffCoverageLedger implements ProgressLedger {
    private targets: CoverageTarget[];

    constructor(params: DiffCoverageLedgerParams) {
        this.targets = buildCoverageLedger(params.changedFiles, {
            fileTiers: params.fileTiers,
        });
    }

    markFromToolCall(toolName: string, input: unknown, step: number): void {
        markCoverageFromToolCall(
            this.targets,
            toolName,
            (input ?? {}) as Record<string, unknown>,
            step,
        );
    }

    summary(): CoreCoverageSummary {
        const s = getCoverageSummary(this.targets);
        // Project the rich domain summary onto the minimal core port.
        return {
            totalTargets: s.totalTargets,
            pendingTargets: s.pendingTargets,
            criticalTotal: s.criticalTotal,
            criticalPending: s.criticalPending,
        };
    }

    coverageSummary(): CoverageSummary {
        return getCoverageSummary(this.targets);
    }

    debtNote(): string | null {
        const debt = formatCoverageDebt(this.targets);
        return debt && debt.length > 0 ? debt : null;
    }

    /** Rich (tiered) satisfaction check — gates the coverage-recovery pass. */
    isSatisfied(): boolean {
        return isCoverageSatisfied(getCoverageSummary(this.targets));
    }

    /** Flat <70% check — gates the second/third-chance passes (legacy floor). */
    isLowCoverage(): boolean {
        const s = getCoverageSummary(this.targets);
        if (s.totalTargets <= 0) return false;
        return s.touchedTargets / s.totalTargets < TIERED_TOTAL_COVERAGE_THRESHOLD;
    }
}
