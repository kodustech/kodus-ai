/**
 * Suggestion sanitizer (#1821): one short call after the finder that removes
 * the suggestions that report no problem at all. Some finder lenses write a
 * suggestion even when their check found nothing ("no sensitive data is
 * exposed", "the change is correct"); those must not reach the review. It only
 * removes non-findings: judging whether a reported problem is real is left to
 * later stages.
 */

export type SanitizerSuggestionLike = {
    relevantFile?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    suggestionContent?: string;
};

export const SANITIZER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['discard'],
    properties: {
        discard: { type: 'array', items: { type: 'integer' } },
    },
} as const;

export function buildSanitizerPrompt(
    suggestions: SanitizerSuggestionLike[],
): string {
    const items = suggestions
        .map((s, i) => {
            const where = `${s.relevantFile ?? '?'}:${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}`;
            return `[${i}] ${where}\n${(s.suggestionContent || '').trim()}`;
        })
        .join('\n\n');
    return `You check the output of a code review before it is posted on a pull request. Each item below is supposed to report a problem for the author to fix: a bug, a risk, a missing check, a test gap, a style issue or an improvement.

Some items instead report that a check found nothing, for example:
- "No sensitive data is exposed to logs or responses."
- "The change only fixes the ignored context; no signature change."
- "Placeholders match the interpolation keys; no new mismatch introduced."
- "This typo is pre-existing and not made worse by this PR."
These report no problem and must not be posted.

Return in "discard" the index of every item that reports no problem for the author to fix.

Keep every item that reports a problem, even a small, speculative or possibly wrong one: deciding whether a reported problem is real is not your job.

The test: if the item asks the author to change, add, fix, use or check anything, it reports a problem and is kept, even when it also says that something else is fine (for example "the parsing is correct, but the timeout should be configurable" is kept). Discard only items that ask for no change at all. When in doubt, keep the item.

An empty "discard" list is a normal answer: usually every item reports a problem.

Items:

${items}`;
}

/** Valid, distinct indices of the answer, in ascending order. */
export function sanitizerDiscardIndices(n: number, answer: unknown): number[] {
    const raw = (answer as { discard?: unknown })?.discard;
    if (!Array.isArray(raw)) {
        return [];
    }
    return [
        ...new Set(
            raw.filter(
                (i): i is number => Number.isInteger(i) && i >= 0 && i < n,
            ),
        ),
    ].sort((a, b) => a - b);
}
