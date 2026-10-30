import { allScenarios } from "../scenarios/index.js";
import type { RunVerdict, ScenarioResult } from "./types.js";

// Cells under investigation: they still RUN and REPORT (advisory) but never
// gate the release. Format: "scenario-id" (all cells) or
// "scenario-id×provider×license" (one cell). Keep entries SHORT-LIVED —
// every entry must have an open issue; quarantine is a parking lot, not a
// graveyard. `e2e:report --quarantine` lists candidates by measured flake
// rate so this stays evidence-driven instead of vibes-driven.
export const QUARANTINED: string[] = [];

export function isQuarantined(r: ScenarioResult): boolean {
    return (
        QUARANTINED.includes(r.scenarioId) ||
        QUARANTINED.includes(
            `${r.scenarioId}×${r.cell.provider}×${r.cell.license}`,
        )
    );
}

// Priority lookup from the scenario registry. Unknown id → P0
// (conservative: an unregistered scenario should gate, not slip through).
export function priorityOf(scenarioId: string): string {
    return allScenarios[scenarioId]?.priority ?? "P0";
}

export function describeCell(r: ScenarioResult): string {
    return `${r.scenarioId} × ${r.cell.target} × ${r.cell.provider} × ${r.cell.license}`;
}

/**
 * P0 cells that SHOULD have run and did not, because of infrastructure —
 * GitHub quota exhausted, target unreachable. Not failures, not passes:
 * coverage that silently went missing.
 *
 * Quarantined cells are excluded: they are already declared non-gating, so
 * an unverified quarantined cell is not news.
 */
export function unverifiedP0(results: ScenarioResult[]): ScenarioResult[] {
    return results.filter(
        (r) =>
            r.status === "skipped" &&
            r.skipKind === "infra" &&
            priorityOf(r.scenarioId) === "P0" &&
            !isQuarantined(r),
    );
}

/**
 * The run's bottom line.
 *
 * The ordering matters: RED wins over INCONCLUSIVE. A run that both broke a
 * gate and lost coverage is red — the missing coverage does not soften a
 * real failure, and reporting it as inconclusive would let a broken gate
 * through on a "we couldn't tell" technicality.
 */
export function computeVerdict(input: {
    gatingFailures: number;
    blocked: number;
    targetCrashed: boolean;
    unverifiedP0: number;
    /**
     * Cells this run was supposed to check (total minus appliesTo skips).
     * Zero means the run verified NOTHING — see below.
     */
    applicable?: number;
    /** Cells that actually RAN: applicable minus setup/infra skips. */
    executed?: number;
}): RunVerdict {
    if (input.gatingFailures > 0 || input.blocked > 0 || input.targetCrashed) {
        return "red";
    }
    if (input.unverifiedP0 > 0) return "inconclusive";
    // A run with nothing applicable is not a pass — it is a run that did not
    // happen. Found live: the self-hosted `github × license-free` cell has no
    // applicable scenario in fast.yml, so it provisioned a droplet, skipped
    // all 12 scenarios as not-applicable, and reported GREEN. That is the
    // exact ambiguity this verdict exists to remove, so it must not survive
    // inside the verdict itself.
    if (input.applicable !== undefined && input.applicable === 0) {
        return "inconclusive";
    }
    // Same reasoning one step further in. `applicable` is total minus
    // appliesTo skips (evidence.ts), so setup and infra skips still COUNT as
    // applicable — a cell whose every scenario self-skipped on a missing
    // secret reports applicable=N, executed=0, and used to come out green.
    // "We were supposed to check N things and checked none of them" is the
    // definition of inconclusive, and it is the exact shape that hid the
    // github-app cell and the centralized-config gap.
    if (
        input.executed !== undefined &&
        input.executed === 0 &&
        (input.applicable ?? 0) > 0
    ) {
        return "inconclusive";
    }
    return "green";
}
