// The PR title a Run keeps for display (the projection's `prTitle`): the Runs
// list names each Run by it, the Run page's header falls back to it. It is the
// author's untrusted text, shown as text only and never interpreted, so the
// Run keeps one clean line of it: no control characters, no bidi controls
// that reorder what the reader sees, at most MAX_PR_TITLE_CHARS characters.

/** Characters (code points, never half a pair) a recorded PR title keeps. */
export const MAX_PR_TITLE_CHARS = 256;

/** Line breaks and tabs, which separate words: read as one space. */
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
/** C0 and C1 controls, DEL, and the bidi marks, embeddings, overrides and isolates. */
// eslint-disable-next-line no-control-regex -- matching a control character is the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One clean line of an untrusted PR title, or undefined when nothing is left to show. */
export function displayPrTitle(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const line = raw.replace(BREAKS, ' ').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
    const cut = Array.from(line).slice(0, MAX_PR_TITLE_CHARS).join('').trimEnd();
    return cut || undefined;
}
