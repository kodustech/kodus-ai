/**
 * REDUCER — the reduce half of an agentic map-reduce over one PR's findings.
 *
 * Replaces the verify+dedup pair with a SINGLE pass that sees the whole
 * candidate set at once. The split it collapses:
 *   - verify judged ONE finding at a time, blind to the other N-1. Measured on
 *     the 30-PR light set it kept 84/85 candidates — it costs one LLM call per
 *     finding and filters ~nothing, because a weak-but-isolated claim has
 *     nothing to be weak *against*.
 *   - dedup saw the whole set but only asked "which of these are the same?",
 *     never "which of these actually matter?".
 * Neither step ever did global prioritization, so noise survived by default.
 *
 * Shape follows Devin's agentic map-reduce writeup (devin.ai/blog/agentic-map-
 * reduce): workers map over shards, then a reducer "consumes the structured
 * outputs, deduplicates overlapping results, reconciles local conclusions, and
 * applies global prioritization to produce one coherent result". Our
 * investigators are the map step; this is the missing reduce step.
 *
 * Cost note: N verify calls + 1 dedup call become 1 call total.
 */

/** JSON schema for the reducer output. `keep` carries the final, ordered set. */
export const REDUCER_SCHEMA = {
    type: 'object',
    properties: {
        keep: {
            type: 'array',
            description:
                'Final findings to report, ordered by importance (most important first).',
            items: {
                type: 'object',
                properties: {
                    index: {
                        type: 'number',
                        description:
                            'Index of the candidate to keep, from the numbered list.',
                    },
                    mergedFrom: {
                        type: 'array',
                        items: { type: 'number' },
                        description:
                            'Indices of other candidates that describe the SAME underlying defect and are folded into this one. Empty when nothing was merged.',
                    },
                    reason: {
                        type: 'string',
                        description:
                            'One sentence: why this finding is worth reporting.',
                    },
                },
                required: ['index', 'mergedFrom', 'reason'],
                additionalProperties: false,
            },
        },
        drop: {
            type: 'array',
            description:
                'Candidates that should NOT be reported, with the reason each was dropped.',
            items: {
                type: 'object',
                properties: {
                    index: { type: 'number' },
                    reason: {
                        type: 'string',
                        description:
                            'Why this one is not worth reporting (not a real defect / speculative / style / already covered).',
                    },
                },
                required: ['index', 'reason'],
                additionalProperties: false,
            },
        },
    },
    required: ['keep', 'drop'],
    additionalProperties: false,
} as const;

type ReducerCandidate = {
    relevantFile?: string;
    relevantLinesStart?: number | string;
    relevantLinesEnd?: number | string;
    label?: string;
    severity?: string;
    oneSentenceSummary?: string;
    suggestionContent?: string;
    existingCode?: string;
    improvedCode?: string;
};

/** Numbered candidate list the reducer reasons over. Richer than the dedup
 *  summary: the reducer judges MERIT, not just similarity, so it needs the
 *  claim's substance (content + the proposed fix), not only a one-liner. */
export function buildReducerCandidates(
    candidates: ReducerCandidate[],
    normalizeSeverity: (severity?: string) => string,
): string {
    return candidates
        .map((c, i) => {
            const loc = `${c.relevantFile || 'unknown'}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}`;
            const head = `[${i}] ${loc} [${c.label || 'unknown'}/${normalizeSeverity(c.severity)}]`;
            const summary = c.oneSentenceSummary
                ? `\n    ${c.oneSentenceSummary}`
                : '';
            const body = c.suggestionContent
                ? `\n    ${c.suggestionContent.slice(0, 600)}`
                : '';
            const fix = c.improvedCode
                ? `\n    fix: ${c.improvedCode.slice(0, 200)}`
                : '';
            return `${head}${summary}${body}${fix}`;
        })
        .join('\n\n');
}

/**
 * Full reducer prompt. The bar is deliberately "would a senior reviewer leave
 * this comment on the PR" — a merit test over the whole set, not a per-item
 * plausibility test (which is what verify already does badly on its own).
 */
export function buildReducerPrompt(
    candidates: ReducerCandidate[],
    normalizeSeverity: (severity?: string) => string,
    /** Forces the DROP rule to be exercised. Measured over three 30-PR runs,
     *  the reducer dropped 1 candidate out of 412 — every removal came from
     *  MERGE. The rule exists and the model never reaches for it, so the
     *  counterweight below ("do NOT drop a genuine defect…") appears to swamp
     *  it. This variant states the expectation as a rate instead. */
    strict: boolean = false,
): string {
    const list = buildReducerCandidates(candidates, normalizeSeverity);
    const strictClause = strict
        ? `

A review where every candidate survives is a review that judged nothing. In a
set this size, expect a real fraction of the candidates to fail the DROP test —
speculative claims, style dressed as defects, and nitpicks are the normal output
of investigators working blind to each other. Go through them one at a time and
put each in drop or keep on its own merits. If you genuinely cannot fault a
candidate, keep it; do not manufacture a drop to hit a number.`
        : '';
    return `You are the final reviewer for ONE pull request. Several independent
investigators each looked at a different part of this PR and produced the
candidate findings below. They could not see each other's work, so the set has
duplicates, near-duplicates, and claims that look important in isolation but do
not hold up against the PR as a whole.

Your job is to produce the FINAL review: the findings actually worth posting on
this PR, ordered by importance.

Decide with the whole set in view:

1. MERGE — several candidates describing the SAME underlying defect become ONE.
   This includes the same mistake repeated at different call sites, methods or
   files (one fix resolves them all): keep the clearest instance and list the
   others in mergedFrom.
2. DROP — a candidate that is not worth a reviewer's comment:
   - the claim does not hold up (speculative, or contradicted by the code shown);
   - pure style, naming, formatting, or a generic "missing X" with no concrete
     failure;
   - a minor nitpick that would be noise next to the real problems in this set.
3. KEEP — everything else, ordered most important first. Importance = how much
   the defect would actually hurt (correctness/security impact, blast radius),
   not how confident the investigator sounded.

Be decisive: a review with 3 real problems is more useful than one with 12
where the real ones are buried. But do NOT drop a genuine defect just to make
the list shorter — a real bug at low severity still belongs in KEEP.

Every candidate index must appear exactly once, in keep (as index or inside a
mergedFrom) or in drop.${strictClause}

CANDIDATES:
${list}`;
}
