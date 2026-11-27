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
        const lined = new Set(
            group.filter(
                (s) =>
                    !!s.relevantFile &&
                    !!s.relevantLinesStart &&
                    !s.fileAnchored,
            ),
        );
        // PR-level findings, three ways:
        //   - file-anchored: per file, its other lines in "Also found in";
        //   - a file and no line: one per rule. Every file shard sees the PR
        //     title, so a title rule scoped to files flags each file; posting
        //     one comment per file repeated the same claim N times. The other
        //     files go in "Also found in";
        //   - no file: one per rule, as before.
        const LINE_LESS = '\0line-less';
        const prLevelByFile = new Map<string, T[]>();
        for (const s of group) {
            if (lined.has(s)) continue;
            const key = s.fileAnchored
                ? (s.relevantFile ?? '')
                : s.relevantFile
                  ? LINE_LESS
                  : '';
            prLevelByFile.set(key, [...(prLevelByFile.get(key) ?? []), s]);
        }
        const prLevel = [...prLevelByFile.values()].map((same) => {
            const [kept, ...rest] = [...same].sort(byDetail);
            const otherLocations = collectOtherLocations(kept, rest);
            if (same.length > 1) {
                onMerge?.({
                    ruleUuid,
                    scope: 'pr',
                    collapsed: same.length,
                    otherLocations: otherLocations.length,
                });
            }
            return otherLocations.length
                ? { ...kept, kodyRuleOtherLocations: otherLocations }
                : kept;
        });

        if (lined.size <= 1) {
            result.push(...lined, ...prLevel);
            continue;
        }

        const sorted = [...lined].sort(byDetail);
        const keep = { ...sorted[0] };
        const otherLocations = collectOtherLocations(keep, sorted.slice(1));

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
            collapsed: lined.size,
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

/** The distinct locations of `others`, other than `kept`'s own. */
function collectOtherLocations<T extends Partial<CodeSuggestion>>(
    kept: T,
    others: T[],
): string[] {
    // A line-less finding names its file alone.
    const locationOf = (s: T) =>
        !s.relevantFile
            ? null
            : s.relevantLinesStart
              ? `${s.relevantFile}:${s.relevantLinesStart}-${s.relevantLinesEnd ?? s.relevantLinesStart}`
              : s.relevantFile;
    const keptLocation = locationOf(kept);
    const locations = new Set<string>();
    for (const s of others) {
        const loc = locationOf(s);
        if (loc && loc !== keptLocation) locations.add(loc);
    }
    return [...locations];
}
