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

/**
 * Index of the first `[` that opens at the TOP level — outside every earlier
 * balanced value and outside every string. Returns -1 when there is none.
 *
 * Anchoring on `text.indexOf('[')` was not safe. A leading object carrying its
 * own array — `{"a":[{"index":0,"suggestionContent":"…"}],"b":1}` followed by
 * the real answer — puts a suggestion-SHAPED array in front of the one the
 * model actually meant. Slicing there parses cleanly, so `parseOk` goes true
 * and that decoy ships to the pull request while both the real answer and the
 * scaffolding fallback are discarded. Wrong content presented as the review is
 * a worse outcome than either failure this recovery exists to prevent.
 */
function firstTopLevelBracket(text: string): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '[') {
            if (depth === 0) {
                return i;
            }
            depth++;
        } else if (ch === '{') {
            depth++;
        } else if (ch === ']' || ch === '}') {
            if (depth > 0) {
                depth--;
            }
        }
    }

    return -1;
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
            break;
        }

        // Still a string after normalisation → JSON encoded inside a JSON
        // string, which json_object mode produces. Unwrap one level.
        try {
            const unwrapped = JSON.parse(value);
            if (typeof unwrapped !== 'string') {
                // Parsed to something that is not a nested string — the
                // envelope pass already had its chance at it. Fall through to
                // the last-resort rules rather than giving up here.
                break;
            }
            value = unwrapped;
        } catch {
            break;
        }
    }

    // Last resort: anchor on the array itself.
    //
    // The envelope path reads the FIRST balanced JSON value, which is the wrong
    // one when the model puts something else in front — a note object
    // (`{"note": "..."} [{...}]`) or a fenced block followed by the array. The
    // regex this replaced happened to survive those because it spanned from the
    // first `[` to the last `]`; losing them was a real regression, silently
    // sending the whole batch to the scaffolding fallback and giving up the
    // prose polish for nothing.
    //
    // The bracket has to open at the TOP level: one nested inside a leading
    // object is a decoy, and accepting it would ship the wrong content as the
    // review. See firstTopLevelBracket.
    const firstBracket = firstTopLevelBracket(text);
    if (firstBracket > 0) {
        const tail = normalizeEnvelope(
            text.slice(firstBracket),
            'items',
            ARRAY_ALIASES,
        ) as { items?: unknown };
        if (Array.isArray(tail?.items)) {
            return tail.items;
        }
    }

    // Nothing at the top level. The text may still be a single wrapper object
    // whose key is one we do not know -- {"whatever": [...]}. Lifting it is safe
    // ONLY when there is exactly one array-valued key: with two, there is no
    // basis for choosing, and choosing wrong is how a decoy ships as the review.
    //
    // This is deliberately the LAST rule, after the top-level scan. When both a
    // wrapper array and a top-level array exist, the top-level one is the
    // model's answer and the nested one is the decoy.
    const lone = loneArrayInObject(text);
    if (lone) {
        return lone;
    }

    return null;
}

/**
 * End index of the JSON value that opens at `start`, or -1 when it never
 * closes. String-aware, so a brace inside a string never moves the depth.
 */
function balancedEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0) return i;
        }
    }

    return -1;
}

/** Every top-level balanced JSON value in the text, in order. */
function allBalancedJsonValues(text: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '{' || ch === '[') {
            const end = balancedEnd(text, i);
            if (end === -1) break;
            out.push(text.slice(i, end + 1));
            i = end + 1;
        } else {
            i++;
        }
    }
    return out;
}

/**
 * The single array reachable through a wrapper object, or null.
 *
 * It scans EVERY top-level JSON value, not just the first. Reading only the
 * first was wrong in both directions: a note object in front of a wrapped
 * answer (`{"note":"x"} {"suggestions":[…]}`) refused a recovery that was
 * unambiguous, and — far worse — a LEADING object carrying its own array
 * (`{"a":[decoy]} {"suggestions":[real]}`) handed back the decoy, which is the
 * exact failure `firstTopLevelBracket` exists to prevent. Both brackets are
 * nested there, so the top-level scan returns -1 and this rule decides alone.
 *
 * "Exactly one array in the WHOLE text" keeps the guard: with two there is no
 * basis for choosing, and choosing wrong ships fabricated content as the
 * review, so it refuses and the deterministic strip takes over.
 */
function loneArrayInObject(text: string): unknown[] | null {
    const arrays: unknown[][] = [];

    for (const candidate of allBalancedJsonValues(text)) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(candidate);
        } catch {
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
        }
        for (const value of Object.values(parsed as Record<string, unknown>)) {
            if (Array.isArray(value)) arrays.push(value);
        }
    }

    return arrays.length === 1 ? arrays[0] : null;
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
