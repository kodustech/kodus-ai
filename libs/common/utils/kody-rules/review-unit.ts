import type { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * The key that identifies ONE review judgment unit among the units of a single
 * review, and the key detector hits and candidate lines are read back with
 * (issue #2509).
 *
 * `uuid` alone cannot serve: a long rule reaches review decomposed into atoms,
 * and `KodyRuleSummaryService.expandForReview` gives every atom unit the
 * PARENT's uuid on purpose, because citations, severity and path/scope routing
 * must resolve to the rule the customer wrote. Anything keyed per unit then
 * merges the atoms: a line one atom's detector flagged becomes a candidate line
 * for its siblings, an atom whose own detector fired nowhere is judged anyway,
 * and a title lookup keyed by uuid ends up naming the last atom.
 *
 * `reviewUnitId` is set only on those atom units, so a rule that was never
 * decomposed keeps indexing under its own uuid and that path is unchanged.
 */
export function reviewUnitKey(rule: Partial<IKodyRule>): string | undefined {
    return rule.reviewUnitId ?? rule.uuid;
}
