/**
 * Shared dedup prompt + schema + model, extracted from
 * `agent-review.stage.ts#deduplicateSuggestions` so production and the
 * `evals/dedup` harness call the SAME prompt — no drift between what ships and
 * what we measure. Behavior-preserving: production imports these and keeps its
 * own group→kept mapping; the eval reuses them to invoke the real dedup decision.
 */

/** JSON schema for the dedup LLM output (groups + unique indices). */
export const DEDUP_SCHEMA = {
    type: 'object',
    properties: {
        groups: {
            type: 'array',
            description:
                'Groups of suggestions. Each group has a representative and its duplicates.',
            items: {
                type: 'object',
                properties: {
                    keep: {
                        type: 'number',
                        description:
                            'Index of the best suggestion to keep as representative',
                    },
                    duplicates: {
                        type: 'array',
                        items: { type: 'number' },
                        description:
                            'Indices of duplicate suggestions (same bug, same or different locations)',
                    },
                },
                required: ['keep', 'duplicates'],
                additionalProperties: false,
            },
        },
        unique: {
            type: 'array',
            items: { type: 'number' },
            description: 'Indices of suggestions that have no duplicates',
        },
    },
    required: ['groups', 'unique'],
    additionalProperties: false,
} as const;

// Content guard: the LLM proposes which suggestions to merge, but only honor a
// merge when the two findings actually describe the same thing. We measure that
// with word-overlap (Jaccard) of summary+fix+content. A low-similarity "duplicate"
// is a DIFFERENT bug the model over-merged (e.g. two distinct issues on
// overlapping lines) — keep it instead of dropping. 0.3 was tuned on the dedup
// eval (39 PRs / 136 goldens): over-merge 3.0→0, no real bug dropped across 6 runs.
export const DEDUP_CONTENT_THRESHOLD = 0.3;

function wordSet(text: string): Set<string> {
    return new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []);
}

function bodyWords(f?: { oneSentenceSummary?: string; suggestionContent?: string }): Set<string> {
    return wordSet(`${f?.oneSentenceSummary || ''} ${f?.suggestionContent || ''}`);
}

function codeWords(f?: { improvedCode?: string }): Set<string> {
    return wordSet(f?.improvedCode || '');
}

function jaccard(A: Set<string>, B: Set<string>): number {
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
}

/** Word-overlap (Jaccard) of two findings' text. 0 = nothing in common, 1 = identical. */
export function contentSimilarity(
    a?: { oneSentenceSummary?: string; improvedCode?: string; suggestionContent?: string },
    b?: { oneSentenceSummary?: string; improvedCode?: string; suggestionContent?: string },
): number {
    const bodyA = bodyWords(a), bodyB = bodyWords(b);
    const bodySim = jaccard(bodyA, bodyB);

    // Only let `improvedCode` influence the score when BOTH findings carry one.
    // A one-sided code block would otherwise inflate its own word set and drag a
    // real duplicate below DEDUP_CONTENT_THRESHOLD, so the guard vetoes a correct
    // merge (the live PR #1526 case). When both have code the combined set can
    // only strengthen the signal, so take the max.
    const codeA = codeWords(a), codeB = codeWords(b);
    if (codeA.size && codeB.size) {
        const A = new Set([...bodyA, ...codeA]);
        const B = new Set([...bodyB, ...codeB]);
        return Math.max(bodySim, jaccard(A, B));
    }
    return bodySim;
}

type DedupSuggestionLike = {
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

/**
 * CHEAP (no-LLM) sibling of the LLM dedup: greedily collapse near-duplicate
 * findings by CONTENT similarity, keeping the most detailed representative per
 * cluster. Same `contentSimilarity` + `DEDUP_CONTENT_THRESHOLD` primitives the
 * LLM path is calibrated against, so there's a single source of truth for "how
 * similar is a duplicate". Content-based (not location): two DIFFERENT bugs on
 * the same line have distinct text and stay separate. Used by the heavy finder
 * to drop resample paraphrases BEFORE the per-candidate verify (the expensive
 * stage); the LLM dedup still runs later for the final cross-agent grouping.
 */
export function collapseNearDuplicates<T extends DedupSuggestionLike>(
    suggestions: T[],
    threshold: number = DEDUP_CONTENT_THRESHOLD,
): T[] {
    const detail = (s: T) =>
        (s.suggestionContent?.length ?? 0) + (s.improvedCode?.length ?? 0);
    // Bucket representatives BY FILE so the similarity scan only compares
    // same-file candidates (a keyed Map lookup instead of a linear scan of every
    // representative per item). Two findings only collapse within the same file
    // anyway, so this is behavior-preserving.
    const byFile = new Map<string, T[]>();
    for (const s of suggestions) {
        const file = s.relevantFile ?? '';
        let bucket = byFile.get(file);
        if (!bucket) {
            bucket = [];
            byFile.set(file, bucket);
        }
        const match = bucket.find((r) => contentSimilarity(r, s) >= threshold);
        if (!match) {
            bucket.push(s);
        } else if (detail(s) > detail(match)) {
            // Promote the more detailed suggestion to representative, then fold
            // any OTHER bucket members the new (richer) text now covers but the
            // old representative didn't — otherwise the same cluster stays split
            // and redundant resample paraphrases reach the per-finding verify.
            bucket[bucket.indexOf(match)] = s;
            for (let i = bucket.length - 1; i >= 0; i--) {
                if (
                    bucket[i] !== s &&
                    contentSimilarity(bucket[i], s) >= threshold
                ) {
                    bucket.splice(i, 1);
                }
            }
        }
    }
    return [...byFile.values()].flat();
}

/**
 * Build the per-suggestion summary block the dedup model sees. `normalizeSeverity`
 * is injected so production keeps its exact severity normalization; callers that
 * don't need it (the eval) can pass an identity function.
 */
export function buildDedupSummaries(
    suggestions: DedupSuggestionLike[],
    normalizeSeverity: (severity?: string) => string,
): string {
    return suggestions
        .map(
            (s, i) =>
                `[${i}] ${s.relevantFile || 'unknown'}:${s.relevantLinesStart}-${s.relevantLinesEnd} [${s.label || 'unknown'}/${normalizeSeverity(s.severity)}]: ${s.oneSentenceSummary || s.suggestionContent?.substring(0, 200)}${s.improvedCode ? `\n    fix: ${s.improvedCode.substring(0, 100)}` : ''}`,
        )
        .join('\n');
}

/** Full dedup prompt (instructions + the suggestion summaries). */
export function buildDedupPrompt(
    suggestions: DedupSuggestionLike[],
    normalizeSeverity: (severity?: string) => string,
): string {
    const summaries = buildDedupSummaries(suggestions, normalizeSeverity);
    return `You have ${suggestions.length} code review suggestions across multiple files in a PR. Identify duplicates and group them.

BE CONSERVATIVE — when in doubt, do NOT group. Only group when you are highly confident they describe the exact same bug.

There are TWO types of duplicates:

1. **EXACT DUPLICATES** (same bug, same location): Multiple suggestions pointing to the same file and overlapping lines describing the same issue. Keep the one with the most detail, discard the rest.

2. **CROSS-LOCATION DUPLICATES** (same bug pattern, different locations): Suggestions describing the EXACT SAME code pattern/bug but applied in different files (e.g., "forEach with async callback" found in 3 different files, or "missing null check on the same API call" in 2 files). These should be GROUPED — keep the best one as representative, list the others as duplicates.

NOT duplicates (keep both):
- Different bugs in the same file or nearby lines (e.g., "nil pointer" and "missing validation" in the same controller — these are DIFFERENT bugs)
- Different root causes even if they sound similar (e.g., "add nil check" vs "fix typo" — different problems)
- Suggestions about different code even if the description sounds similar

IGNORE the category label (bug/security/performance) when deciding — two agents can independently find the same issue.
Prefer keeping the suggestion with the most detail or clearest fix as the representative.

${summaries}`;
}

// ── Semantic tier (PR #1527) ────────────────────────────────────────────────
// When lexical overlap is below DEDUP_CONTENT_THRESHOLD the guard can't tell a
// real duplicate worded differently from two distinct bugs on the same lines.
// A semantic embedding cosine separates the clear ends; the ambiguous middle is
// escalated to a focused LLM tiebreak. Bands tuned on evals/dedup/guard-pairs.json.
export const DEDUP_EMBEDDING_LOW = 0.4;
export const DEDUP_EMBEDDING_HIGH = 0.7;

/** Cosine similarity of two embedding vectors. 0 if either is empty/mismatched. */
export function cosineSimilarity(a?: number[], b?: number[]): number {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0,
        na = 0,
        nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Text embedded for the semantic tier: the finding's meaning (summary + content),
 * NOT its code — two different bugs on the same lines share code but not meaning. */
export function dedupEmbeddingText(f?: DedupSuggestionLike): string {
    return `${f?.oneSentenceSummary || ''}. ${f?.suggestionContent || ''}`.trim();
}

export const DEDUP_TIEBREAK_SCHEMA = {
    type: 'object',
    properties: {
        rootCauseA: { type: 'string' },
        rootCauseB: { type: 'string' },
        sameBug: { type: 'boolean' },
    },
    required: ['rootCauseA', 'rootCauseB', 'sameBug'],
    additionalProperties: false,
} as const;

/** Focused pairwise "same bug?" prompt for the ambiguous embedding band. Unlike
 * the batch dedup (which sees truncated summaries), this sees the FULL text of
 * both findings and names each root cause before comparing — the root-cause-first
 * framing is what made this reliable on the guard-pairs eval. */
export function buildTiebreakPrompt(
    a: DedupSuggestionLike,
    b: DedupSuggestionLike,
): string {
    const fmt = (f: DedupSuggestionLike) =>
        `Summary: ${f?.oneSentenceSummary || ''}\nDetails: ${f?.suggestionContent || ''}\nExisting code: ${f?.existingCode || ''}\nSuggested fix: ${f?.improvedCode || ''}`;
    return `Two code review findings on the same PR. Decide whether posting both would be a REDUNDANT DUPLICATE (same underlying defect) or whether they are DIFFERENT bugs that both deserve a comment.

First, in one short phrase each, state the single root-cause defect of A and of B. Then compare:
- sameBug = TRUE when both point at the SAME defect — even if the wording, the emphasis, or the suggested fix differ (e.g. two ways to fix the same prototype-pollution hole, or the same N+1 query described differently).
- sameBug = FALSE when the defects are genuinely different problems, even if they sit on the same lines or the same function (e.g. a null-deref crash vs an inverted authorization check; a security hole vs a performance issue).

Finding A:
${fmt(a)}

Finding B:
${fmt(b)}`;
}
