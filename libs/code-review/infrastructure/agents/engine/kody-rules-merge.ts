import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * Merges Kody Rule findings deterministically by rule UUID, without a model:
 * the UUID says which rule each finding belongs to.
 *
 *   - PR-level (no file, or a file with no cited line): keep the most
 *     detailed finding, drop the rest. A PR-level rule is broken once per PR.
 *   - File-level (a file and a line): keep the most detailed finding and
 *     carry the other locations on `kodyRuleOtherLocations`, rendered as
 *     "Also found in" after the formatter (#2015).
 *
 * A rule with findings of both shapes gets one of each. The PR-level one is
 * posted as a PR comment (#2420), which keeps no location of its own: a lined
 * finding folded under it would live only in the comment's text, out of reach
 * of the implementation check and of the record of where the rule was broken.
 *
 * Shared by agent-review.stage.ts and evals/review-rounds, so the eval merges
 * what the stage merges.
 */
export interface KodyRuleMerge {
    ruleUuid: string;
    scope: 'pr' | 'file';
    collapsed: number;
    otherLocations: number;
}

export function mergeKodyRuleFindings<T extends Partial<CodeSuggestion>>(
    suggestions: T[],
    onMerge?: (merge: KodyRuleMerge) => void,
): T[] {
    if (suggestions.length <= 1) {
        return suggestions;
    }

    const groupsByRuleUuid = new Map<string, T[]>();
    const passthrough: T[] = [];

    for (const s of suggestions) {
        const ruleUuid = s.brokenKodyRulesIds?.[0];
        if (!ruleUuid) {
            passthrough.push(s);
            continue;
        }
        const group = groupsByRuleUuid.get(ruleUuid) || [];
        group.push(s);
        groupsByRuleUuid.set(ruleUuid, group);
    }

    const result: T[] = [...passthrough];
    const byDetail = (a: T, b: T) =>
        (b.suggestionContent?.length || 0) - (a.suggestionContent?.length || 0);

    for (const [ruleUuid, group] of groupsByRuleUuid) {
        // Only a finding posted inline has a location to list. One without a
        // file, without a line (#2420), or file-anchored outside the diff is
        // posted PR-level, so it is never folded into an inline one's "Also
        // found in" nor absorbs one.
        const lined = group.filter(
            (s) =>
                !!s.relevantFile && !!s.relevantLinesStart && !s.fileAnchored,
        );
        // PR-level findings collapse per file: a file-name rule broken by
        // two files is two violations, each kept on its own record.
        const prLevelByFile = new Map<string, T[]>();
        for (const s of group) {
            if (lined.includes(s)) continue;
            const key = s.relevantFile ?? '';
            prLevelByFile.set(key, [...(prLevelByFile.get(key) ?? []), s]);
        }
        const prLevel = [...prLevelByFile.values()].map((same) => {
            if (same.length > 1) {
                onMerge?.({
                    ruleUuid,
                    scope: 'pr',
                    collapsed: same.length,
                    otherLocations: 0,
                });
            }
            return [...same].sort(byDetail)[0];
        });

        if (lined.length <= 1) {
            result.push(...lined, ...prLevel);
            continue;
        }

        const sorted = [...lined].sort(byDetail);
        const keep = { ...sorted[0] };
        const otherLocations: string[] = [];
        const locationOf = (s: T) =>
            `${s.relevantFile}:${s.relevantLinesStart}-${s.relevantLinesEnd ?? s.relevantLinesStart}`;
        const keptLocation = locationOf(keep);

        for (let i = 1; i < sorted.length; i++) {
            const loc = locationOf(sorted[i]);
            if (loc !== keptLocation && !otherLocations.includes(loc)) {
                otherLocations.push(loc);
            }
        }

        if (otherLocations.length > 0) {
            // Carried on the suggestion instead of written into
            // suggestionContent: the content formatter runs after this merge
            // and rewrites suggestionContent from scratch, which folded this
            // list into prose or dropped it (#2015).
            keep.kodyRuleOtherLocations = otherLocations;
        }

        onMerge?.({
            ruleUuid,
            scope: 'file',
            collapsed: lined.length,
            otherLocations: otherLocations.length,
        });
        result.push(keep, ...prLevel);
    }

    return result;
}

/** Heads the list of a comment's other locations; the implementation check reads it back. */
export const OTHER_LOCATIONS_HEADING = '**Also found in:**';

/**
 * The merged locations to render under "Also found in", without the comment's
 * own range. Each merge leaves out the location it kept, but the kept finding
 * can change in a later merge, or have its lines moved, so the list is
 * checked against where the comment actually lands.
 */
export function otherLocationsToRender(
    suggestion: Pick<
        Partial<CodeSuggestion>,
        | 'relevantFile'
        | 'relevantLinesStart'
        | 'relevantLinesEnd'
        | 'alsoFoundIn'
        | 'kodyRuleOtherLocations'
    >,
): string[] {
    const start = suggestion.relevantLinesStart;
    const end = suggestion.relevantLinesEnd;
    const own = new Set([
        `${suggestion.relevantFile}:${start}-${end}`,
        `${suggestion.relevantFile}:${start ?? '?'}-${end ?? '?'}`,
        // mergeKodyRuleFindings renders a start-only range as `start-start`.
        ...(start != null
            ? [`${suggestion.relevantFile}:${start}-${start}`]
            : []),
    ]);
    return [
        ...new Set([
            ...(suggestion.alsoFoundIn || []),
            ...(suggestion.kodyRuleOtherLocations || []),
        ]),
    ].filter(
        (location) =>
            // A finding with no cited line (#2420 routes those PR-level) has no
            // location to name: `file:?-?` is noise, not a place to look.
            !location.endsWith(':?-?') && !own.has(location),
    );
}
