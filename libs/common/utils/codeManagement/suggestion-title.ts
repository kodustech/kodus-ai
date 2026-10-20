import { splitSentences } from './suggestion-body-shape';

/** Hard ceiling for a suggestion title; the prompt asks for 80 or fewer. */
export const MAX_TITLE_CHARS = 100;

/** Prompt wording for the title field, shared by every finding prompt. */
export const TITLE_PROMPT_SPEC =
    'Title of the finding: one line, 80 characters or fewer, names the problem (not the fix), no trailing period';

const normalize = (text: string): string =>
    text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.。]+$/, '')
        .trim();

const firstSentence = (body: string): string =>
    (splitSentences(body)[0] ?? '').replace(/[.!?]$/, '');

const trimCutEnd = (text: string): string => text.replace(/[\s,;:–—-]+$/, '');

/**
 * Bounded at a word boundary. A boundary inside inline code would leave the
 * span open and break the markdown of the whole title, so the cut moves back
 * to before the span; a title that opens with a span too long to keep closes
 * it instead.
 */
const cut = (title: string): string => {
    if (title.length <= MAX_TITLE_CHARS) return title;
    // One char for the ellipsis, one for a closing backtick if it is needed.
    const room = title.slice(0, MAX_TITLE_CHARS - 2);
    const lastSpace = room.lastIndexOf(' ');
    const head = trimCutEnd(lastSpace > 0 ? room.slice(0, lastSpace) : room);
    if (head.split('`').length % 2 === 1) return `${head}…`;
    const beforeSpan = trimCutEnd(head.slice(0, head.lastIndexOf('`')));
    return beforeSpan ? `${beforeSpan}…` : `${head}\`…`;
};

/**
 * The title a suggestion is rendered with, before it is bounded: the model's
 * summary, or the first sentence of the body when the summary is missing.
 * The formatter rewrites one over MAX_TITLE_CHARS; boundSuggestionTitle is the
 * net for what is still too long after it.
 */
export function fullSuggestionTitle(params: {
    summary?: string | null;
    body?: string | null;
}): string {
    const summary = normalize(params.summary ?? '');
    return summary || normalize(firstSentence(params.body ?? ''));
}

/** A title bounded to MAX_TITLE_CHARS at a word boundary. */
export function boundSuggestionTitle(title?: string | null): string {
    return cut(normalize(title ?? ''));
}

/**
 * fullSuggestionTitle, bounded to MAX_TITLE_CHARS at a word boundary.
 */
export function resolveSuggestionTitle(params: {
    summary?: string | null;
    body?: string | null;
}): string {
    return boundSuggestionTitle(fullSuggestionTitle(params));
}
