import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * Merges Kody Rule findings deterministically by rule UUID, without a model:
 * the UUID says which rule each finding belongs to.
 *
 *   - PR-level (no relevantFile): keep the most detailed finding, drop the
 *     rest. A PR-level rule is broken once per PR.
 *   - File-level: keep the most detailed finding and carry the other
 *     locations on `kodyRuleOtherLocations`, rendered as "Also found in"
 *     after the formatter (#2015).
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
        if (group.length === 1) {
            result.push(group[0]);
            continue;
        }

        if (group.every((s) => !s.relevantFile)) {
            result.push([...group].sort(byDetail)[0]);
            onMerge?.({
                ruleUuid,
                scope: 'pr',
                collapsed: group.length,
                otherLocations: 0,
            });
            continue;
        }

        const sorted = [...group].sort(byDetail);
        const keep = { ...sorted[0] };
        const otherLocations: string[] = [];
        // A finding with no cited line has no location to name: the previous
        // `?? '?'` placeholder rendered as `file:?-?` and inflated the merge
        // count. Those findings are routed PR-level (#2420), so skip them.
        const locationOf = (s: T): string | null => {
            const start = s.relevantLinesStart;
            if (!start) {
                return null;
            }
            return `${s.relevantFile}:${start}-${s.relevantLinesEnd ?? start}`;
        };
        const keptLocation = locationOf(keep);

        for (let i = 1; i < sorted.length; i++) {
            const dup = sorted[i];
            const loc = locationOf(dup);
            if (loc && loc !== keptLocation && !otherLocations.includes(loc)) {
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
            collapsed: group.length,
            otherLocations: otherLocations.length,
        });
        result.push(keep);
    }

    return result;
}

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
