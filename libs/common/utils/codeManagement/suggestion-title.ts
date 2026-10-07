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

const cut = (title: string): string => {
    if (title.length <= MAX_TITLE_CHARS) return title;
    const room = title.slice(0, MAX_TITLE_CHARS - 1);
    const lastSpace = room.lastIndexOf(' ');
    const head = lastSpace > 0 ? room.slice(0, lastSpace) : room;
    return `${head.replace(/[\s,;:–—-]+$/, '')}…`;
};

/**
 * The title a suggestion is rendered with: the model's summary, or the first
 * sentence of the body when the summary is missing, bounded to
 * MAX_TITLE_CHARS at a word boundary.
 */
export function resolveSuggestionTitle(params: {
    summary?: string | null;
    body?: string | null;
}): string {
    const summary = normalize(params.summary ?? '');
    const title = summary || normalize(firstSentence(params.body ?? ''));
    return cut(title);
}
