const WHOLE_FENCE = /^```([\w-]*)[ \t]*\n([\s\S]*?)\n```$/;
const FENCE_LINE = /^```/m;

/**
 * Returns the markdown inside a fence that wraps the whole answer, as models
 * sometimes do when asked for a bare document.
 *
 * A document may itself open with one code block and close with another, and
 * the same pattern matches it. So the answer is unwrapped only when the fence
 * says it holds markdown, or when it names no language and holds no other
 * fence. Anything else comes back as is, trimmed.
 */
export function unwrapMarkdownFence(text: string): string {
    const trimmed = text.trim();
    const match = WHOLE_FENCE.exec(trimmed);
    if (!match) {
        return trimmed;
    }

    const [, language, inner] = match;
    const declaresMarkdown = /^(markdown|md)$/i.test(language);
    if (declaresMarkdown || (!language && !FENCE_LINE.test(inner))) {
        return inner.trim();
    }
    return trimmed;
}
