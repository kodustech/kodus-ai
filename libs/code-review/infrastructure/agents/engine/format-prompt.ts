/**
 * Pure suggestion-format prompt + response parse — shared by production
 * (`format-suggestion-content.ts`) and the format eval so there is no prompt drift.
 */
import { normalizeEnvelope } from '@libs/llm/structured-output-repair';

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

/** Wrapper keys models reach for when they decline to answer with a bare array. */
const ARRAY_ALIASES = [
    'suggestions',
    'result',
    'results',
    'formatted',
    'data',
    'items',
];

/**
 * Pull the array out of whatever the model actually said.
 *
 * This used to be `text.match(/\[[\s\S]*\]/)` — a hand-rolled grab that fails
 * on the shapes non-strict models routinely emit, while the repository already
 * carried a tested recovery for exactly this problem: `normalizeEnvelope`, from
 * the #1786 audit, used at nineteen other call sites. This one place simply
 * never adopted it.
 *
 * It handles a bare array, a markdown fence, prose around the JSON, and a
 * wrapper object under any alias key. The second pass covers the one shape a
 * single pass does not — JSON encoded inside a JSON string, which json_object
 * mode produces.
 *
 * Prose with no JSON in it comes back unrecovered, and that is the point: a
 * refusal has to stay a refusal rather than be coerced into an empty success.
 */
function extractSuggestionArray(text: string): unknown[] | null {
    let value: unknown = text;

    // Bounded, because each pass peels exactly one layer and a model that
    // nests deeper than this is not answering the prompt at all.
    for (let pass = 0; pass < 4; pass++) {
        const envelope = normalizeEnvelope(value, 'items', ARRAY_ALIASES) as {
            items?: unknown;
        };
        const inner = envelope?.items;

        if (Array.isArray(inner)) {
            return inner;
        }

        // A wrapper around a wrapper — {result: {result: [...]}} is real, and
        // the hand-rolled regex this replaced happened to find the array
        // through it. Peel and go again.
        if (inner && typeof inner === 'object') {
            value = inner;
            continue;
        }

        if (typeof value !== 'string') {
            return null;
        }

        // Still a string after normalisation → JSON encoded inside a JSON
        // string, which json_object mode produces. Unwrap one level.
        try {
            const unwrapped = JSON.parse(value);
            if (typeof unwrapped !== 'string') {
                return null;
            }
            value = unwrapped;
        } catch {
            return null;
        }
    }

    return null;
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

    const items = extractSuggestionArray(text);
    if (!items) {
        return { formatted, parseOk: false };
    }

    for (const item of items as any[]) {
        if (
            item &&
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
}
