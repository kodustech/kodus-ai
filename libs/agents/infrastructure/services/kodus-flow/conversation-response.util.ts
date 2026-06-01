/**
 * Shown to the user when the conversation agent produced nothing usable —
 * better a clear message than a raw `{"content":""}` blob in a PR comment.
 */
export const CONVERSATION_FALLBACK_MESSAGE =
    "I wasn't able to put together an answer for that. Could you rephrase " +
    'your question or add a bit more context?';

function isContentEnvelope(value: unknown): value is { content: unknown } {
    return !!value && typeof value === 'object' && 'content' in value;
}

/**
 * If `text` is a JSON object carrying a `content` key, return that
 * `content` value so the caller can keep unwrapping. Returns `undefined`
 * when `text` is not such an envelope — i.e. it is a real answer that
 * merely happens to be (or start with) JSON.
 */
function unwrapJsonEnvelope(text: string): unknown | undefined {
    if (!text.startsWith('{') || !text.endsWith('}')) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        if (isContentEnvelope(parsed)) {
            return parsed.content;
        }
    } catch {
        // Not JSON — a real answer that just happens to start with '{'.
    }
    return undefined;
}

/**
 * Normalize whatever the conversation agent returned into the plain text
 * to post back to the user.
 *
 * The result can arrive in several shapes:
 *  - a plain string (the happy path)
 *  - a `{ content: ... }` envelope object — the agent sometimes wraps its
 *    answer instead of returning the bare string
 *  - a JSON string that is itself such an envelope, e.g. `'{"content":""}'`
 *    — the LLM echoing its response schema instead of answering
 *  - nested combinations of the above
 *
 * @returns the unwrapped answer text, or `null` when there is no usable
 * content (empty / blank / unknown shape) so the caller can surface a
 * graceful fallback instead of posting garbage like `{"content":""}`.
 */
export function normalizeConversationResponse(raw: unknown): string | null {
    let value: unknown = raw;

    // Unwrap a few levels of { content } envelopes (object or JSON-string).
    for (let depth = 0; depth < 4; depth++) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) {
                return null;
            }

            const inner = unwrapJsonEnvelope(trimmed);
            if (inner !== undefined) {
                value = inner;
                continue;
            }

            return trimmed;
        }

        if (isContentEnvelope(value)) {
            value = value.content;
            continue;
        }

        // Unknown / non-string, non-envelope shape — nothing usable.
        return null;
    }

    return null;
}
