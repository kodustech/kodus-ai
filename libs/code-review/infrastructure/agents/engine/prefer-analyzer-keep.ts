import { isAnalyzerSuggestion } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/** A dedup group as the model returns it: indices into the suggestion list. */
export type DedupGroup = { keep: number; duplicates: number[] };

/**
 * Makes the deterministic finding the survivor of any group it lands in.
 *
 * The dedup model chooses `keep` on how a finding reads, and the model's own
 * prose always reads better than a scanner's. That is the wrong trade: a
 * scanner finding is a fact with a rule behind it, and dropping it loses both
 * the provenance (`evidence`) and the guarantee — the agent's version survives
 * only because the agent happened to notice the same thing, so the day it
 * doesn't, the group publishes nothing the scanner proved.
 *
 * Only the roles inside a group change. Which findings were grouped at all is
 * still the model's call, and the caller still validates every index.
 */
export function preferAnalyzerKeep(
    groups: DedupGroup[],
    suggestions: Partial<CodeSuggestion>[],
): DedupGroup[] {
    const isAnalyzerAt = (index: number): boolean =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < suggestions.length &&
        isAnalyzerSuggestion(suggestions[index]);

    return groups.map((group) => {
        const duplicates = group.duplicates ?? [];
        if (isAnalyzerAt(group.keep)) {
            return group;
        }

        const promoted = duplicates.find(isAnalyzerAt);
        if (promoted === undefined) {
            return group;
        }

        return {
            keep: promoted,
            duplicates: [
                group.keep,
                ...duplicates.filter((index) => index !== promoted),
            ],
        };
    });
}
