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

function contentWords(f?: { oneSentenceSummary?: string; improvedCode?: string; suggestionContent?: string }): Set<string> {
    const text = `${f?.oneSentenceSummary || ''} ${f?.improvedCode || ''} ${f?.suggestionContent || ''}`;
    return new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []);
}

/** Word-overlap (Jaccard) of two findings' text. 0 = nothing in common, 1 = identical. */
export function contentSimilarity(
    a?: { oneSentenceSummary?: string; improvedCode?: string; suggestionContent?: string },
    b?: { oneSentenceSummary?: string; improvedCode?: string; suggestionContent?: string },
): number {
    const A = contentWords(a), B = contentWords(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
}

type DedupSuggestionLike = {
    relevantFile?: string;
    relevantLinesStart?: number | string;
    relevantLinesEnd?: number | string;
    label?: string;
    severity?: string;
    oneSentenceSummary?: string;
    suggestionContent?: string;
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
