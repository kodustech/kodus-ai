/**
 * Label normalization (#1821): the deterministic step after anchoring. A
 * suggestion whose label is not one the pipeline routes gets label `bug`
 * instead of being dropped; providers without strict tool schemas do not hold
 * the finder to its label enum. `repo_instruction` stays valid: the
 * repository-instructions findings route on it.
 *
 * Then the team's categories: a suggestion whose label the team turned off is
 * discarded, never moved to a category that is on. A label replaced by `bug`
 * follows the same rule, so a team with bug off loses it.
 */
export const VALID_FINDING_LABELS = [
    'bug',
    'security',
    'performance',
    'kody_rules',
    'repo_instruction',
] as const;

export const FALLBACK_FINDING_LABEL = 'bug';

const VALID = new Set<string>(VALID_FINDING_LABELS);

export type NormalizeFinderLabelsOptions<T> = {
    /** Labels the team receives; a suggestion with any other is discarded. */
    allowed?: ReadonlySet<string>;
    /** Suggestions the team's categories do not apply to (Kody Rules, custom agents). */
    exempt?: (s: T) => boolean;
};

export type NormalizeFinderLabelsResult<T> = {
    suggestions: T[];
    /** Labels replaced by `bug`, by the label the finder wrote. */
    replaced: Record<string, number>;
    /** Suggestions whose label the team turned off, already normalized. */
    discarded: T[];
};

export function normalizeFinderLabels<T extends { label?: unknown }>(
    suggestions: T[],
    { allowed, exempt }: NormalizeFinderLabelsOptions<T> = {},
): NormalizeFinderLabelsResult<T> {
    const replaced: Record<string, number> = {};
    const kept: T[] = [];
    const discarded: T[] = [];
    for (const s of suggestions) {
        const raw = typeof s.label === 'string' ? s.label : '';
        let label = raw.trim().toLowerCase();
        if (!VALID.has(label)) {
            const key = raw || String(s.label);
            replaced[key] = (replaced[key] || 0) + 1;
            label = FALLBACK_FINDING_LABEL;
        }
        const out = label === s.label ? s : { ...s, label };
        if (allowed && !allowed.has(label) && !exempt?.(s)) {
            discarded.push(out);
        } else {
            kept.push(out);
        }
    }
    return { suggestions: kept, replaced, discarded };
}
