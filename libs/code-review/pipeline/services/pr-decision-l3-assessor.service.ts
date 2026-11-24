import { Injectable } from '@nestjs/common';

import type {
    L3AssessInput,
    L3Assessor,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import type { GateVerdict } from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import type { L3Verdict } from '@libs/code-review/domain/risk/pr-decision-reducer';

/**
 * The L3 gate adapter. It reads the approval decision the pipeline already
 * produced (`DecidePrApprovalStage` → `context.approvalDecision`) rather
 * than re-running the policy matcher: the matcher already resolved the
 * policies against this head SHA, and re-running it would duplicate the
 * provider reads and the eligibility cache.
 *
 * Mapping from `ApprovalDecision.kind` to the L3 verdict:
 *   - `approve`     → `Ready({matchedPolicyId, unmatchedReasons: []})`
 *   - `hold`        → `Ready({matchedPolicyId: null, unmatchedReasons: [reason]})`
 *   - `out-of-scope`→ `Ready({matchedPolicyId: null, unmatchedReasons: [reason]})`
 *   - `disabled`    → `Unavailable(...)`: automatic approval is switched off,
 *                     so no policy could match. The reducer vetoes with
 *                     source `l3` — which is the correct outcome: an
 *                     unapproved PR must not be auto-approved.
 *
 * The assessor is STATELESS: the decision arrives on the input. The
 * reconciler may run for several PRs concurrently in one worker process, so
 * a module-level holder would let one PR's reconcile read another PR's
 * decision.
 */
@Injectable()
export class PrDecisionL3AssessorService implements L3Assessor {
    async assess(input: L3AssessInput): Promise<GateVerdict<L3Verdict>> {
        const decision = input.approvalDecision;

        if (!decision) {
            return {
                status: 'Unavailable',
                reason: 'The policy matcher produced no verdict for this PR; fail-closed.',
                snapshotKey: input.snapshotKey,
            };
        }

        if (decision.kind === 'disabled') {
            return {
                status: 'Unavailable',
                reason: decision.reason || 'Automatic approval is disabled.',
                snapshotKey: input.snapshotKey,
            };
        }

        if (decision.kind === 'approve') {
            return {
                status: 'Ready',
                value: {
                    matchedPolicyId: decision.matchedPolicy?.id ?? null,
                    unmatchedReasons: [],
                },
                snapshotKey: input.snapshotKey,
            };
        }

        return {
            status: 'Ready',
            value: {
                matchedPolicyId: null,
                unmatchedReasons: [decision.reason],
            },
            snapshotKey: input.snapshotKey,
        };
    }
}
