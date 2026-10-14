import { Inject, Injectable } from '@nestjs/common';

import {
    LoadPrDecisionsParams,
    MAX_PR_DECISIONS,
    PrDecisionRecord,
    PrDecisionStore,
    PR_DECISION_STORE_TOKEN,
} from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';

/**
 * Fetches the suggestions already posted on the PR and keeps the most recent
 * {@link MAX_PR_DECISIONS}. Pure orchestration over {@link PrDecisionStore} —
 * no Mongo import here, so this is testable with an in-memory store.
 */
@Injectable()
export class BuildPreviousReviewDecisionsUseCase implements IUseCase {
    constructor(
        @Inject(PR_DECISION_STORE_TOKEN)
        private readonly store: PrDecisionStore,
    ) {}

    async execute(
        params: LoadPrDecisionsParams,
    ): Promise<PrDecisionRecord[]> {
        const decisions = await this.store.load(params);
        if (!decisions.length) {
            return [];
        }

        return capDecisions(decisions);
    }
}

/** Most recent first (by `decidedAt`), across the whole PR — file-level and
 *  PR-level together — capped at {@link MAX_PR_DECISIONS}. There is no
 *  per-file cap: a file's older suggestions must not drop out while other
 *  files are quiet, and code moves between files across rounds. */
export function capDecisions(
    decisions: readonly PrDecisionRecord[],
): PrDecisionRecord[] {
    return [...decisions].sort(byDecidedAtDesc).slice(0, MAX_PR_DECISIONS);
}

/** Most-recent-first comparator. A record missing `decidedAt` (legacy data
 *  predating the field) sorts last instead of throwing — one malformed record
 *  must not cost the whole PR its history via the outer fail-open catch. */
function byDecidedAtDesc(a: PrDecisionRecord, b: PrDecisionRecord): number {
    return (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '');
}
