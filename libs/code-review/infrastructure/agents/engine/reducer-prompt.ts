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
 *
 * MEASURED FAILURE that shaped the DROP rule's current wording: across 29 PRs
 * the reducer discards 45% of all candidates (136 of 301), and judging those
 * discards against the goldens found FOUR that the agents had correctly found
 * and it deleted. Two were name/docstring defects — a component whose name
 * contradicts its behaviour, a docstring stating a return type the method no
 * longer has — dropped because the rule said "pure style, naming, formatting"
 * without separating a naming PREFERENCE from a name that is false about the
 * code. The system was working against itself: one agent exists to find
 * exactly those, and this prompt told the reducer to delete them.
 *
 * The other rule that cost findings was relative: "a minor nitpick that would
 * be noise next to the real problems in this set" makes a correct low-severity
 * finding's survival depend on what else happens to share its PR. Recall counts
 * it the same either way, and so does the reader. Importance now decides order
 * only.
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
    reason?: string;
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
            // O percurso que produziu o achado, quando o gerador foi obrigado a
            // registra-lo. Sem isto o reducer julga a CONCLUSAO sem o caminho
            // — que e como todos os filtros desta investigacao operaram, tendo
            // menos material do que o agente que gerou.
            const why = c.reason ? `\n    walk: ${c.reason.slice(0, 700)}` : '';
            return `${head}${summary}${body}${fix}${why}`;
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
    /** The reducer has grep/readFile and is expected to use them. Without
     *  tools it can only rate plausibility, and plausibility does not separate
     *  a true claim from a false one: measured over 30 PRs the false positives
     *  carry the same phrasing, the same confidence and the same severity as
     *  the true ones (39 of 118 at High). Verification does. */
    investigate: boolean = false,
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
    const investigateClause = investigate
        ? `

You have grep and readFile over the repository at the commit under review, and
you are expected to use them. Most of these candidates are wrong, and what makes
one wrong is almost never visible in how it is written — the claims that fail
read exactly like the claims that hold. Do not decide by how plausible or
confident a candidate sounds. Check it.

Before you keep or drop a candidate, turn it into a question the code answers,
and answer it:
  - it says a caller breaks       -> read the caller
  - it says a value can be null   -> read what produces it
  - it says a guard is missing    -> grep for the guard elsewhere in the file
  - it says work repeats          -> read whether something already caches it
  - it says a symbol is absent    -> grep for it before believing that

DROP the ones the code contradicts, and the ones asking for a defence nobody has
shown is needed: a bound, a limit, a validation or a rate limit is a hardening
suggestion, not a defect, unless you found a caller that actually violates it.

KEEP what you confirmed, and KEEP what you could not check — an unverified claim
is not a refuted one. Say in its reason which of the two it is.`
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
   - a preference with no defect behind it: how something is spelled, formatted
     or arranged, a rename that changes nothing a reader or caller can observe,
     a generic "missing X" with no concrete failure named.

   A name, comment, docstring or message that is FALSE about the code is NOT a
   preference — it is a defect in what the next reader is told, and it stays.
   "This should be called X" is a preference; "this says it returns a list and
   it returns a dict" is a defect. Judge the claim, not the wording the
   investigator chose: one phrased as a remedy ("rename this", "update the
   docs") still has to be read for the defect behind it.
3. KEEP — everything else, ordered most important first. Importance = how much
   the defect would actually hurt (correctness/security impact, blast radius),
   not how confident the investigator sounded.

   Importance decides ORDER, never whether something is reported. A correct
   finding does not become noise because a worse one shares the set with it;
   drop only on a candidate's own merits, never by comparison.

Be decisive: a review with 3 real problems is more useful than one with 12
where the real ones are buried. But do NOT drop a genuine defect just to make
the list shorter — a real bug at low severity still belongs in KEEP.

Every candidate index must appear exactly once, in keep (as index or inside a
mergedFrom) or in drop.${investigateClause}${strictClause}

CANDIDATES:
${list}`;
}
