import { Inject, Injectable } from '@nestjs/common';

import {
    LoadPrDecisionsParams,
    PrDecisionRecord,
    PrDecisionStore,
    PR_DECISION_STORE_TOKEN,
} from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';

/** Most-recent decisions kept per changed file — bounds prompt growth on a
 *  long-lived PR that went through many review rounds. Same spirit as
 *  `traceDecisions`' `droppedForBudget` and `ConversationStore`'s message cap. */
const MAX_DECISIONS_PER_FILE = 5;

/** Hard cap across the whole run, applied after the per-file cap. */
const MAX_DECISIONS_TOTAL = 30;

/**
 * Fetches prior-round decisions for the files under review and applies the
 * size caps. Pure orchestration over {@link PrDecisionStore} — no Mongo import
 * here, so this is testable with an in-memory store.
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

/** Most recent first per file (by `decidedAt`), capped per file then overall.
 *  PR-level decisions (`relevantFile: undefined`) bucket together under the
 *  `undefined` key — they get their own per-bucket cap, same as any file. */
export function capDecisions(
    decisions: readonly PrDecisionRecord[],
): PrDecisionRecord[] {
    const byFile = new Map<string | undefined, PrDecisionRecord[]>();
    for (const decision of decisions) {
        const bucket = byFile.get(decision.relevantFile);
        if (bucket) {
            bucket.push(decision);
        } else {
            byFile.set(decision.relevantFile, [decision]);
        }
    }

    const capped: PrDecisionRecord[] = [];
    for (const bucket of byFile.values()) {
        bucket.sort(byDecidedAtDesc);
        capped.push(...bucket.slice(0, MAX_DECISIONS_PER_FILE));
    }

    capped.sort(byDecidedAtDesc);
    return capped.slice(0, MAX_DECISIONS_TOTAL);
}

/** Most-recent-first comparator. A record missing `decidedAt` (legacy data
 *  predating the field) sorts last instead of throwing — one malformed record
 *  must not cost the whole PR its history via the outer fail-open catch. */
function byDecidedAtDesc(a: PrDecisionRecord, b: PrDecisionRecord): number {
    return (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '');
}
