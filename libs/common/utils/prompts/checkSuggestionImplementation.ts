/** One suggestion as the implementation check shows it to the model. */
export type ImplementationCheckSuggestion = {
    id: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    /** What the suggestion asked for, as the developer read it. */
    problem: string;
    existingCode?: string;
    /** The fix the suggestion proposed; empty when it shipped without one. */
    improvedCode?: string;
};

const linesOf = (s: ImplementationCheckSuggestion) =>
    s.relevantLinesStart
        ? s.relevantLinesEnd && s.relevantLinesEnd !== s.relevantLinesStart
            ? `${s.relevantLinesStart}-${s.relevantLinesEnd}`
            : `${s.relevantLinesStart}`
        : 'unknown';

export const prompt_checkSuggestionImplementation = (payload: {
    file: { filename: string; patch: string };
    suggestions: ImplementationCheckSuggestion[];
}) => {
    const suggestions = payload.suggestions.map((s) => ({
        id: s.id,
        lines_at_review: linesOf(s),
        problem: s.problem,
        code_at_review: s.existingCode || '',
        ...(s.improvedCode?.trim() ? { one_possible_fix: s.improvedCode } : {}),
    }));

    return `<task>
Code review suggestions were left on the file below, then the developer pushed this patch. For each suggestion, decide if the patch made the change it asked for.
</task>

<rules>
- "implemented": the patch resolves the problem the suggestion raised. Any fix counts, not only "one_possible_fix".
- "partially_implemented": the suggestion asked for several things and the patch resolves some, not all.
- "not_implemented": the problem is still there: its lines untouched, only other code changed, or its lines edited (renamed, reformatted, moved, commented) without resolving it.
- Read only the patch ("+" added, "-" removed). Line numbers are from review time and may have shifted. If the patch does not show the problem resolved, answer "not_implemented".
</rules>

<file path=${JSON.stringify(payload.file.filename)}>
${payload.file.patch}
</file>

<suggestions>
${JSON.stringify(suggestions)}
</suggestions>

Return ONLY {"verdicts":[{"id":string,"implementationStatus":"implemented"|"partially_implemented"|"not_implemented"}]}, one entry per suggestion id above.`;
};
