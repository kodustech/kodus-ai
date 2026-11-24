import type { GateVerdict, L1Verdict } from './pr-decision-graph-verdict';

/**
 * The L0 conditions gate. Pure-function of the PR shape; never Unavailable
 * or Stale under normal operation. Carries a deterministic verdict only.
 */
export type L0Verdict = ReadonlyArray<{
    name: string;
    passed: boolean;
    reason: string;
}>;

/**
 * The L2 verdict. Today the existing {@link assessChangeRisk} returns
 * `RiskAssessmentResult`. The reducer consumes its boolean projection:
 * risk identifed or not. The reason is what the audit panel surfaces.
 */
export interface L2Verdict {
    riskIdentified: boolean;
    reason: string;
}

/**
 * The result of matching the configured `approvalPolicies[*]` against the PR.
 * `null` means a policy matched; `string` is the human-readable list of
 * reasons why no policy matched. `HOLD(no-policy)` is the canonical fallback.
 */
export interface L3Verdict {
    matchedPolicyId: string | null;
    unmatchedReasons: string[];
}

/**
 * Reducer input. Each gate verdict is independent of the others; the reducer
 * folds them bitwise into a single desired host state.
 */
export interface ReducerInput {
    snapshotKey: string;
    l0: GateVerdict<L0Verdict>;
    l1: GateVerdict<L1Verdict>;
    l2: GateVerdict<L2Verdict>;
    l3: GateVerdict<L3Verdict>;
}

/**
 * The reducer's output. `APPROVE` is a positive decision; `HOLD` is a veto
 * with a human-readable reason; `ORCH_FAIL` means the reducer itself could
 * not compose a coherent state (rare; reserved for snapshot-key mismatch).
 */
export type DesiredHostState =
    | {
          kind: 'APPROVE';
          policyId: string;
          snapshotKey: string;
          reason: string;
      }
    | {
          kind: 'HOLD';
          snapshotKey: string;
          reason: string;
          /** Which gates vetoed, for the audit panel. */
          vetoSources: ReadonlyArray<'l1' | 'l2' | 'l3' | 'stale-snapshot'>;
      }
    | {
          kind: 'ORCH_FAIL';
          snapshotKey: string;
          reason: string;
      };

/**
 * Pure reducer. Reads gates → desired host state. No I/O. The reconciler
 * pair with this function never short-circuits; it folds the truth table
 * top-down so the audit panel gets a complete *why*.
 *
 * Reasoning (per the spec):
 *
 *   L1 Unavailable  →  no contribution (Q1 ratified: escalates to L2)
 *   L1 Ready(HIGH)  →  veto (`l1` source on HOLD)
 *   L1 Ready(MEDIUM) →  combined with L2 verdict; L2 either confirms or vetoes.
 *                       Defers to L2 because weight 0.30 (test_gaps) is the
 *                       heavier of L2's two contributors at the contribution
 *                       level below 0.6.
 *   L1 Ready(LOW)   →  no contribution.
 *   L1 Stale        →  HOLD(veto=stale-snapshot)
 *   L2 Unavailable  →  HOLD(reason, l2 source; LLM is fail-closed)
 *   L2 Ready(risk)  →  HOLD(veto=l2, reason=L2's prose)
 *   L2 Ready(clean) →  no veto from L2
 *   L2 Stale        →  HOLD(veto=stale-snapshot)
 *   L3 Ready(matched) →  no veto (the policy matched; reducer then chooses APPROVE)
 *   L3 Ready(unmatched) →  HOLD(reason, veto=l3, "no policy matched")
 *   L3 Unavailable  →  HOLD(veto=l3, "policy matcher unavailable")
 *   L3 Stale        →  HOLD(veto=stale-snapshot)
 *
 * When no gate vetoed and L3 matched → APPROVE(policyId).
 * When no gate vetoed and L3 did not match → HOLD(veto=l3, "no policy matched").
 */
export function reduce(input: ReducerInput): DesiredHostState {
    const snap = input.snapshotKey;

    // Snapshot-stale is a global pre-condition: any Stale verdict forces a HOLD.
    // The gate snapshot JSON identifies which specific gate is stale.
    const staleSources: Array<'l1' | 'l2' | 'l3' | 'stale-snapshot'> = [];
    if (
        input.l0.status === 'Stale' ||
        input.l1.status === 'Stale' ||
        input.l2.status === 'Stale' ||
        input.l3.status === 'Stale'
    ) {
        staleSources.push('stale-snapshot');
    }
    if (staleSources.length > 0) {
        return {
            kind: 'HOLD',
            snapshotKey: snap,
            reason: 'One or more gate verdicts are stale; re-evaluate.',
            vetoSources: staleSources,
        };
    }

    const vetoSources: Array<'l1' | 'l2' | 'l3' | 'stale-snapshot'> = [];
    const reasons: string[] = [];

    // L0: structural filters (no current vetoing; surface failures to L3).
    if (input.l0.status === 'Ready') {
        const failed = input.l0.value.filter((c) => !c.passed);
        if (failed.length > 0) {
            reasons.push(
                `L0 conditions failed: ${failed.map((c) => c.name).join(', ')}`,
            );
        }
    }
    // L0 Unavailable is unexpected but not veto-by-default.

    // L1: HIGH risk → veto on l1 source. Unavailable = no contribution (Q1).
    if (input.l1.status === 'Ready' && input.l1.value.level === 'HIGH') {
        vetoSources.push('l1');
        reasons.push(
            `L1 risk HIGH: ${input.l1.value.factors[0]?.detail ?? 'wide blast radius'}`,
        );
    }
    // L1 MEDIUM does not veto on its own (per the spec's layered audit); it
    // adds context to the reason string.
    if (input.l1.status === 'Ready' && input.l1.value.level === 'MEDIUM') {
        reasons.push(
            `L1 risk MEDIUM (not vetoing alone): blast ${input.l1.value.blastRadius.totalFunctions} fn / ${input.l1.value.blastRadius.totalFiles} files`,
        );
    }

    // L2: the traditional risk engine; Available semantics preserved.
    if (input.l2.status === 'Unavailable') {
        vetoSources.push('l2');
        reasons.push(`L2 risk unavailable: ${input.l2.reason}; fail-closed.`);
    } else if (input.l2.status === 'Ready' && input.l2.value.riskIdentified) {
        vetoSources.push('l2');
        reasons.push(`L2 risk found: ${input.l2.value.reason}`);
    }

    // L3: policy matcher.
    let matchedPolicyId: string | null = null;
    let unmatchedReasons: string[] = [];
    if (input.l3.status === 'Unavailable') {
        vetoSources.push('l3');
        reasons.push(`L3 policy matcher unavailable: ${input.l3.reason}`);
    } else if (input.l3.status === 'Ready') {
        matchedPolicyId = input.l3.value.matchedPolicyId;
        unmatchedReasons = input.l3.value.unmatchedReasons;
        if (matchedPolicyId === null) {
            vetoSources.push('l3');
            reasons.push(
                `No policy matched: ${unmatchedReasons.join('; ') || 'unmatched'}`,
            );
        }
    }

    if (vetoSources.length > 0) {
        return {
            kind: 'HOLD',
            snapshotKey: snap,
            reason: reasons.join(' | ') || 'A gate vetoed approval.',
            vetoSources,
        };
    }

    if (matchedPolicyId === null) {
        // Should be unreachable given the L3 branch above, but keeps TS exhaustive.
        return {
            kind: 'HOLD',
            snapshotKey: snap,
            reason: 'No policy matched.',
            vetoSources: ['l3'],
        };
    }

    if (
        reasons.length > 0 &&
        reasons.every((r) => r.includes('L1 risk MEDIUM'))
    ) {
        // L1 MEDIUM context is non-vetoing; it rides along on the approval reason.
    }

    return {
        kind: 'APPROVE',
        policyId: matchedPolicyId,
        snapshotKey: snap,
        reason:
            reasons.length > 0
                ? `Policy '${matchedPolicyId}' matched. Context: ${reasons.join(' | ')}`
                : `Policy '${matchedPolicyId}' matched.`,
    };
}

/** Convenience constructor for a Ready verdict (the data source ships tests). */
export function readyValue<T>(value: T, snapshotKey: string): GateVerdict<T> {
    return { status: 'Ready', value, snapshotKey };
}

/** Convenience constructor for an Unavailable verdict. */
export function unavailable<T>(
    snapshotKey: string,
    reason: string,
): GateVerdict<T> {
    return { status: 'Unavailable', reason, snapshotKey };
}

/** Convenience constructor for a Stale verdict. */
export function stale<T>(
    snapshotKey: string,
    priorSnapshotKey: string,
): GateVerdict<T> {
    return { status: 'Stale', snapshotKey, priorSnapshotKey };
}
