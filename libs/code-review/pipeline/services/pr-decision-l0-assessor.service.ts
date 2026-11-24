import { Injectable } from '@nestjs/common';

import type {
    L0AssessInput,
    L0Assessor,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import type { GateVerdict } from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import type { L0Verdict } from '@libs/code-review/domain/risk/pr-decision-reducer';

/**
 * The L0 gate: deterministic conditions over the PR's shape.
 *
 * L0 is the only gate with no external dependency. It is pure: the same PR
 * shape always yields the same verdict, so it can never be `Unavailable` and
 * never needs a snapshot key check. Per the reducer's contract, an L0 failure
 * is not vetoing on its own — it surfaces in the reason string and the
 * decision is made by the other gates.
 *
 * The assessor is STATELESS: the PR shape arrives on the input, not from a
 * module-level holder. The reconciler may run for several PRs concurrently
 * in one worker process, so a holder would let one PR's reconcile read
 * another PR's shape.
 */
@Injectable()
export class PrDecisionL0AssessorService implements L0Assessor {
    async assess(input: L0AssessInput): Promise<GateVerdict<L0Verdict>> {
        const shape = input.prShape ?? {};

        const conditions: L0Verdict = [
            {
                name: 'not-draft',
                passed: shape.isDraft !== true,
                reason: shape.isDraft
                    ? 'The pull request is a draft.'
                    : 'The pull request is not a draft.',
            },
            {
                name: 'not-bot-author',
                passed: shape.isBotAuthor !== true,
                reason: shape.isBotAuthor
                    ? 'The pull request was opened by a bot.'
                    : 'The pull request was opened by a person.',
            },
        ];

        return {
            status: 'Ready',
            value: conditions,
            snapshotKey: input.snapshotKey,
        };
    }
}
