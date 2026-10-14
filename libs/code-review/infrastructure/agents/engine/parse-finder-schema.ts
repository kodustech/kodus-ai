/**
 * Parse schema (#1821): the deterministic step between the finder and the
 * dedup. From here on a suggestion carries only the five fields of the lean
 * finder output, plus `llmPrompt` (a copy of suggestionContent set when the
 * agent output is mapped to the pipeline shape; the comment uses it). Every
 * other field is removed: `existingCode` and `improvedCode` come back at
 * enrichment, `producedBy` only mattered for the finder's recall.
 *
 * Required: label and suggestionContent always; relevantFile,
 * relevantLinesStart and relevantLinesEnd unless the label is kody_rules,
 * whose PR-level findings have no file and no lines. A suggestion missing a
 * required field is discarded and reported.
 */
export const LEAN_FINDER_FIELDS = [
    'label',
    'relevantFile',
    'relevantLinesStart',
    'relevantLinesEnd',
    'suggestionContent',
] as const;

export type LeanFinderField = (typeof LEAN_FINDER_FIELDS)[number];

const ACCEPTED_FIELDS = [...LEAN_FINDER_FIELDS, 'llmPrompt', 'oneSentenceSummary', 'revisesSuggestionId'];

const LOCATION_FIELDS: LeanFinderField[] = [
    'relevantFile',
    'relevantLinesStart',
    'relevantLinesEnd',
];

export type LeanSuggestion = {
    label: string;
    relevantFile?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    suggestionContent: string;
    llmPrompt?: string;
};

export type ParseFinderSchemaResult = {
    suggestions: LeanSuggestion[];
    discarded: Array<{ index: number; missing: LeanFinderField[] }>;
    /** Fields removed, by count. */
    removedFields: Record<string, number>;
};

const isPresent = (v: unknown) =>
    v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

export function parseFinderSchema(
    suggestions: Array<Record<string, unknown>>,
): ParseFinderSchemaResult {
    const out: LeanSuggestion[] = [];
    const discarded: ParseFinderSchemaResult['discarded'] = [];
    const removedFields: Record<string, number> = {};
    (suggestions || []).forEach((s, index) => {
        const item = s && typeof s === 'object' ? s : {};
        for (const k of Object.keys(item)) {
            if (!ACCEPTED_FIELDS.includes(k)) {
                removedFields[k] = (removedFields[k] || 0) + 1;
            }
        }
        const required: LeanFinderField[] = [
            'label',
            'suggestionContent',
            ...(item.label === 'kody_rules' ? [] : LOCATION_FIELDS),
        ];
        const missing = LEAN_FINDER_FIELDS.filter(
            (f) => required.includes(f) && !isPresent(item[f]),
        );
        if (missing.length) {
            discarded.push({ index, missing });
            return;
        }
        out.push(
            Object.fromEntries(
                ACCEPTED_FIELDS.filter((f) => isPresent(item[f])).map((f) => [
                    f,
                    item[f],
                ]),
            ) as LeanSuggestion,
        );
    });
    return { suggestions: out, discarded, removedFields };
}
