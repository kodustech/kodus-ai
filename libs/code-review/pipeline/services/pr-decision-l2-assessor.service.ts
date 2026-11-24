import { Injectable } from '@nestjs/common';

import type {
    L2AssessInput,
    L2Assessor,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import type { GateVerdict } from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import type { L2Verdict } from '@libs/code-review/domain/risk/pr-decision-reducer';

/**
 * The L2 gate adapter. It reads the risk assessment the pipeline already
 * produced (`AssessPrRiskStage` → `context.riskAssessment`) rather than
 * issuing a second LLM call: the reconciler samples the latest verdict of
 * each gate at the trigger instant (`design.md §Decision 1`), and the risk
 * engine's verdict for this head SHA is exactly that.
 *
 * Semantics preserved from the existing risk engine:
 *   - `assessed` + `riskIdentified` → the LLM found risk → veto source `l2`
 *   - `assessed` + no risk → no contribution
 *   - `unavailable` → fail closed. The reducer vetoes with source `l2`.
 *   - `disabled` → the risk engine is switched off. This is NOT
 *     "unavailable": it is an explicit configuration choice, so it must not
 *     veto, and it must not be reported as a failed assessment either.
 *
 * The assessor is STATELESS: the verdict arrives on the input. The
 * reconciler may run for several PRs concurrently in one worker process, so
 * a module-level holder would let one PR's reconcile read another PR's
 * risk assessment.
 */
@Injectable()
export class PrDecisionL2AssessorService implements L2Assessor {
    async assess(input: L2AssessInput): Promise<GateVerdict<L2Verdict>> {
        const assessment = input.riskAssessment;

        if (!assessment) {
            return {
                status: 'Unavailable',
                reason: 'The risk engine produced no verdict for this PR; fail-closed.',
                snapshotKey: input.snapshotKey,
            };
        }

        if (assessment.status === 'disabled') {
            // The engine is off by configuration. The verdict carries no risk
            // and no veto: the reducer treats a Ready(false) as "no
            // contribution", exactly as it treats an L1 LOW.
            return {
                status: 'Ready',
                value: {
                    riskIdentified: false,
                    reason: 'Risk assessment is disabled for this repository.',
                },
                snapshotKey: input.snapshotKey,
            };
        }

        if (assessment.status === 'unavailable') {
            return {
                status: 'Unavailable',
                reason: assessment.reason,
                snapshotKey: input.snapshotKey,
            };
        }

        return {
            status: 'Ready',
            value: {
                riskIdentified: assessment.riskIdentified,
                reason: assessment.reason,
            },
            snapshotKey: input.snapshotKey,
        };
    }
}
