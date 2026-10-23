/**
 * Label normalization (#1821): the deterministic step after anchoring. A
 * suggestion whose label is not one the pipeline routes is kept with label
 * `bug` instead of being dropped; providers without strict tool schemas do not
 * hold the finder to its label enum. `repo_instruction` stays valid: the
 * repository-instructions findings route on it.
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

export type NormalizeFinderLabelsResult<T> = {
    suggestions: T[];
    /** Labels replaced by `bug`, by the label the finder wrote. */
    replaced: Record<string, number>;
};

export function normalizeFinderLabels<T extends { label?: unknown }>(
    suggestions: T[],
): NormalizeFinderLabelsResult<T> {
    const replaced: Record<string, number> = {};
    const out = suggestions.map((s) => {
        const raw = typeof s.label === 'string' ? s.label : '';
        const label = raw.trim().toLowerCase();
        if (VALID.has(label)) {
            return label === s.label ? s : { ...s, label };
        }
        const key = raw || String(s.label);
        replaced[key] = (replaced[key] || 0) + 1;
        return { ...s, label: FALLBACK_FINDING_LABEL };
    });
    return { suggestions: out, replaced };
}
