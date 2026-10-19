import { isAnalyzerSuggestion } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import type { DedupGroup } from './prefer-analyzer-keep';

type Located = Partial<CodeSuggestion> | undefined;

const contains = (outer: Located, inner: Located): boolean =>
    !!outer?.relevantFile &&
    outer.relevantFile === inner?.relevantFile &&
    outer.relevantLinesStart != null &&
    outer.relevantLinesEnd != null &&
    inner.relevantLinesStart != null &&
    inner.relevantLinesEnd != null &&
    outer.relevantLinesStart <= inner.relevantLinesStart &&
    inner.relevantLinesEnd <= outer.relevantLinesEnd;

const span = (s: Partial<CodeSuggestion>): number =>
    s.relevantLinesEnd! - s.relevantLinesStart!;

const SEVERITY_RANK: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};
const rank = (s: Partial<CodeSuggestion>): number =>
    SEVERITY_RANK[String(s.severity ?? '').toLowerCase()] ?? 4;

/**
 * The survivor's text, fix and severity are what ship: the classifier re-rates
 * that text and the team's severity floor can drop it. So a narrower finding
 * takes over only when it is rated at least as high and keeps a fix the
 * model's pick had.
 */
const canReplace = (
    dup: Partial<CodeSuggestion>,
    keep: Partial<CodeSuggestion>,
): boolean =>
    rank(dup) <= rank(keep) &&
    (!keep.improvedCode?.trim() || !!dup.improvedCode?.trim());

/**
 * Two findings of one bug at one place: same file, one range inside the other.
 * The wider one is not another location to list under "Also found in".
 */
export function isSameSpot(a: Located, b: Located): boolean {
    return contains(a, b) || contains(b, a);
}

/**
 * Makes the finding on the defective lines the survivor of its group.
 *
 * The dedup model keeps the finding with the most detail, which is often the
 * one that cites the whole function. The comment is anchored on the survivor's
 * lines, so it sat on the signature while the lines at fault appeared only
 * under "Also found in" (#2157). A duplicate whose range lies inside the
 * survivor's, in the same file, points at the same bug more precisely; the
 * narrowest one that is rated as high and keeps the fix is promoted, with its
 * own text, code and fix.
 *
 * Only the roles inside a group change, and a scanner finding promoted by
 * preferAnalyzerKeep stays the survivor.
 */
export function preferSpecificKeep(
    groups: DedupGroup[],
    suggestions: Partial<CodeSuggestion>[],
): DedupGroup[] {
    return groups.map((group) => {
        const keep = suggestions[group.keep];
        if (!keep || isAnalyzerSuggestion(keep)) {
            return group;
        }

        const duplicates = group.duplicates ?? [];
        let promoted: number | undefined;
        for (const index of duplicates) {
            const dup = suggestions[index];
            if (
                !dup ||
                !contains(keep, dup) ||
                span(dup) >= span(keep) ||
                !canReplace(dup, keep)
            ) {
                continue;
            }
            if (
                promoted === undefined ||
                span(dup) < span(suggestions[promoted])
            ) {
                promoted = index;
            }
        }
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
