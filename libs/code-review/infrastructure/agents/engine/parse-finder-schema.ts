/**
 * Parse schema (#1821): the deterministic check between the finder and the
 * anchoring. A finder suggestion must carry the lean fields it is asked for:
 * label and suggestionContent always; relevantFile, relevantLinesStart and
 * relevantLinesEnd unless the label is kody_rules, whose PR-level findings
 * have no file and no lines. A suggestion missing one is discarded and
 * reported. The lean shape itself comes from the finding mapper
 * (finding-mapper.ts, `leanOutput`); snippets, fix and title come at
 * enrichment.
 */
import { LEAN_FINDER_FIELDS } from '@libs/code-review/infrastructure/agents/core/finder-output-schema';

export { LEAN_FINDER_FIELDS };

export type LeanFinderField = (typeof LEAN_FINDER_FIELDS)[number];

const CONTENT_FIELDS: LeanFinderField[] = ['label', 'suggestionContent'];
const LOCATION_FIELDS = LEAN_FINDER_FIELDS.filter(
    (f) => !CONTENT_FIELDS.includes(f),
);

export type ParseFinderSchemaResult = {
    discarded: Array<{ index: number; missing: LeanFinderField[] }>;
};

const isPresent = (v: unknown) =>
    v !== undefined &&
    v !== null &&
    !(typeof v === 'string' && v.trim() === '');

export function parseFinderSchema(
    suggestions: Array<Record<string, unknown>>,
): ParseFinderSchemaResult {
    const discarded: ParseFinderSchemaResult['discarded'] = [];
    (suggestions || []).forEach((s, index) => {
        const item = s && typeof s === 'object' ? s : {};
        const label = item.label;
        const required: LeanFinderField[] = [
            ...CONTENT_FIELDS,
            ...(label === 'kody_rules' ? [] : LOCATION_FIELDS),
        ];
        const missing = LEAN_FINDER_FIELDS.filter(
            (f) => required.includes(f) && !isPresent(item[f]),
        );
        if (missing.length) discarded.push({ index, missing });
    });
    return { discarded };
}
