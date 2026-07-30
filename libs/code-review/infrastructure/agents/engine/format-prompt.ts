/**
 * Pure suggestion-format prompt + response parse — shared by production
 * (`format-suggestion-content.ts`) and the format eval so there is no prompt drift.
 */

export interface SuggestionToFormat {
    suggestionContent: string;
    existingCode?: string;
    improvedCode?: string;
    relevantFile?: string;
    language?: string;
}

export interface FormattedSuggestion {
    suggestionContent: string;
    improvedCode: string;
}

export function buildFormatPrompt(
    suggestions: SuggestionToFormat[],
    options?: {
        customWritingGuidelines?: string;
        /** Already-resolved language label (e.g. "Portuguese"), not a locale code. */
        languageLabel?: string | null;
    },
): string {
    const customGuidelines = options?.customWritingGuidelines
        ? `\n\nAdditional writing guidelines from the team:\n${options.customWritingGuidelines}`
        : '';

    const langInstruction = options?.languageLabel
        ? `\nIMPORTANT: Write all output in ${options.languageLabel}. Do not fall back to English.`
        : '';

    const suggestionsText = suggestions
        .map(
            (s, i) =>
                `[${i}]\nFile: ${s.relevantFile || 'unknown'}\nLanguage: ${s.language || 'unknown'}\nContent: ${s.suggestionContent}\nExisting code:\n\`\`\`\n${s.existingCode || '(none)'}\n\`\`\`\nImproved code:\n\`\`\`\n${s.improvedCode || '(none)'}\n\`\`\``,
        )
        .join('\n\n---\n\n');

    return `You are a code review comment editor. Rewrite each suggestion into clean, natural prose.

Rules:
- Remove labels like "WHAT:", "WHY:", "HOW:", "1.", "2.", "3." from the beginning of sentences.
- Merge the labeled sentences into a single natural paragraph (1-3 SHORT sentences). Aim for 2 sentences max: one describing the problem, one describing the fix.
- Keep every technical detail: function names, file names, variable names, error types, line numbers.
- Be concise: the code block already shows the fix, so the text should explain WHY, not repeat WHAT the code does.
- Do NOT touch existingCode or improvedCode — return them exactly as provided.
${customGuidelines ? `\nThe team has provided custom writing guidelines. Follow them — they take priority over the default rules above.\n${customGuidelines}` : ''}${langInstruction}

Example:
Input: "WHAT: The join method breaks out of the loop when the timeout expires. WHY: This leaves subsequent flusher processes running indefinitely as orphans. HOW: Remove the remaining_time check."
Output: "The join method breaks out of the loop when the timeout expires, leaving subsequent flusher processes running indefinitely as orphans. Remove the remaining_time check."

Respond with ONLY a JSON array:
\`\`\`json
[
  {"index": 0, "suggestionContent": "cleaned text"}
]
\`\`\`

Suggestions to clean:

${suggestionsText}`;
}

/**
 * Parse the model response into a map of index → formatted suggestion.
 */
export function parseFormatResponse(text: string): {
    formatted: Map<number, FormattedSuggestion>;
    parseOk: boolean;
} {
    const formatted = new Map<number, FormattedSuggestion>();
    if (!text) {
        return { formatted, parseOk: false };
    }

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
        return { formatted, parseOk: false };
    }

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const item of parsed) {
            if (
                typeof item.index === 'number' &&
                typeof item.suggestionContent === 'string'
            ) {
                formatted.set(item.index, {
                    suggestionContent: item.suggestionContent,
                    improvedCode: item.improvedCode || '',
                });
            }
        }
        return { formatted, parseOk: formatted.size > 0 };
    } catch {
        return { formatted, parseOk: false };
    }
}
