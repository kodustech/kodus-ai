/** Abbreviations that never end a sentence, whatever follows them. */
const NEVER_TERMINAL =
    /(?:^|[^\p{L}.])(?:e\.g|i\.e|cf|vs|approx|incl|esp|resp|viz|et al|a\.k\.a|w\.r\.t)\.$/iu;

/**
 * Endings that end a sentence only when what follows is not lower case:
 * "etc. and", "Wait... then", "1. open the file" and "U.S. users" continue,
 * "etc. The" starts a new sentence.
 */
const TERMINAL_UNLESS_LOWER_CASE_FOLLOWS =
    /(?:\betc\.|\.\.\.|(?:^|[\s:(])\d{1,3}\.|(?:^|\s)(?:\p{L}\.){2,})$/iu;

/** What a sentence can start with; a dash, arrow or bracket continues the previous one. */
const SENTENCE_START = /[\p{L}\p{N}`"'\u201c\u2018*_\[#@$~]/u;

/** Characters that may close a sentence after its stop: quotes, brackets, emphasis. */
const CLOSERS = new Set(['"', "'", '\u201d', '\u2019', ')', ']', '*', '_']);

/** Indexes covered by inline code, from paired backticks; an unmatched one is literal. */
const inlineCodeIndexes = (text: string): Set<number> => {
    const ticks: number[] = [];
    for (let i = 0; i < text.length; i++) if (text[i] === '`') ticks.push(i);
    const covered = new Set<number>();
    for (let t = 0; t + 1 < ticks.length; t += 2) {
        for (let i = ticks[t]; i <= ticks[t + 1]; i++) covered.add(i);
    }
    return covered;
};

/**
 * Sentences of a prose body, each with its closing punctuation (and any
 * closing quote, bracket or emphasis right after it). A sentence ends at `.`,
 * `!` or `?` followed by the end of the text or a space, except:
 * - inside inline code, or when the punctuation stands alone ("Use ?? here");
 * - after "e.g.", "i.e.", "cf.", "vs." and similar, whatever follows;
 * - when what follows cannot start a sentence (a dash, an arrow, a bracket);
 * - when a lower-case word follows `?`, `!`, a closing quote or bracket
 *   ("expired? and"), or follows "etc.", an ellipsis, a list number or
 *   initials.
 * Otherwise a full stop before a lower-case word does end a sentence, because
 * a body that fell back to the finder's own text keeps lower-case starts.
 */
export function splitSentences(body: string): string[] {
    const text = body.replace(/\s+/g, ' ').trim();
    const code = inlineCodeIndexes(text);
    const sentences: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (code.has(i) || (ch !== '.' && ch !== '!' && ch !== '?')) continue;

        let end = i + 1;
        while (end < text.length && CLOSERS.has(text[end])) end++;
        if (end < text.length && text[end] !== ' ') continue;

        const piece = text.slice(start, i + 1);
        // A bare "??", "!" or "." is an operator being named, not a stop.
        if (/(?:^|\s)[.!?]+$/.test(piece)) continue;
        if (NEVER_TERMINAL.test(piece)) continue;
        const next = text[end + 1] ?? '';
        if (next && !SENTENCE_START.test(next)) continue;
        if (/\p{Ll}/u.test(next)) {
            // Only a plain full stop ends a sentence before a lower-case word:
            // "expired? and", "'done!' then" and 'said "ok." to' continue.
            if (ch !== '.' || end > i + 1) continue;
            if (TERMINAL_UNLESS_LOWER_CASE_FOLLOWS.test(piece)) continue;
        }

        sentences.push(text.slice(start, end).trim());
        start = end;
        i = end - 1;
    }
    const rest = text.slice(start).trim();
    if (rest) sentences.push(rest);
    return sentences;
}

const words = (text: string): Set<string> =>
    new Set(
        (text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter(Boolean),
    );

/** True when the sentence carries at least 80% of the title's words. */
const restatesTitle = (sentence: string, title: string): boolean => {
    const titleWords = words(title);
    if (!titleWords.size) return false;
    const sentenceWords = words(sentence);
    let covered = 0;
    for (const w of titleWords) if (sentenceWords.has(w)) covered++;
    return covered / titleWords.size >= 0.8;
};

export interface ShapedSuggestionBody {
    body: string;
    removedFences: boolean;
    droppedTitleRepeat: boolean;
    capped: boolean;
}

/**
 * Deterministic shape of the body shown under a suggestion title: no code
 * blocks (the fix is shown separately), no opening sentence that restates the
 * title, and, unless the team wrote its own guidelines, two sentences at most.
 * The model is asked for the same; this holds when it does not comply or the
 * formatter fell back. Reports what it changed so callers can log it.
 */
export function shapeSuggestionBodyWithReport(params: {
    body: string;
    title?: string | null;
    capSentences: boolean;
}): ShapedSuggestionBody {
    const original = params.body ?? '';
    const withoutFences = tidyLayout(original.replace(/```[\s\S]*?```/g, ''));
    const removedFences = /```[\s\S]*?```/.test(original);
    let sentences = splitSentences(withoutFences);
    let text = withoutFences;

    let droppedTitleRepeat = false;
    if (
        params.title &&
        sentences.length > 1 &&
        restatesTitle(sentences[0], params.title)
    ) {
        sentences = sentences.slice(1);
        text = withoutLeadingSentence(text);
        droppedTitleRepeat = true;
    }

    // Only a cut rebuilds the body from its sentences; otherwise lists,
    // tables and paragraphs keep their lines.
    let capped = false;
    if (params.capSentences && sentences.length > 2) {
        text = sentences.slice(0, 2).join(' ');
        capped = true;
    }

    const shaped = text.trim();
    if (!shaped) {
        return {
            body: original,
            removedFences: false,
            droppedTitleRepeat: false,
            capped: false,
        };
    }
    return { body: shaped, removedFences, droppedTitleRepeat, capped };
}

/** Trailing spaces off each line, at most one blank line in a row. */
const tidyLayout = (text: string): string =>
    text
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

/** The text without its first sentence, keeping the layout of the rest. */
function withoutLeadingSentence(text: string): string {
    const [first] = splitSentences(text);
    if (!first) return text;
    const pattern = first
        .split(' ')
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
    const rest = text.replace(new RegExp(`^\\s*${pattern}`), '');
    return rest === text
        ? splitSentences(text).slice(1).join(' ')
        : rest.trim();
}

export function shapeSuggestionBody(params: {
    body: string;
    title?: string | null;
    capSentences: boolean;
}): string {
    return shapeSuggestionBodyWithReport(params).body;
}
