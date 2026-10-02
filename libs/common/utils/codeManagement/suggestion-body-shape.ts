const NON_TERMINAL_ABBREVIATION = /(?:^|[^\p{L}])(?:e\.g|i\.e|cf|vs)\.$/iu;

/**
 * Sentences of a prose body, each with its closing punctuation. A sentence
 * ends at `.`, `!` or `?` followed by the end of the text, or by a space and
 * something other than a lowercase letter ("Use ?? instead", "e.g. this" stay
 * whole); punctuation inside inline code never ends one, and neither does
 * "e.g.", "i.e.", "cf." or "vs.", whatever follows them.
 */
export function splitSentences(body: string): string[] {
    const text = body.replace(/\s+/g, ' ').trim();
    const sentences: string[] = [];
    let start = 0;
    let inCode = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '`') {
            inCode = !inCode;
            continue;
        }
        if (
            !inCode &&
            (ch === '.' || ch === '!' || ch === '?') &&
            (i === text.length - 1 ||
                (text[i + 1] === ' ' &&
                    !/\p{Ll}/u.test(text[i + 2] ?? '') &&
                    !NON_TERMINAL_ABBREVIATION.test(text.slice(start, i + 1))))
        ) {
            sentences.push(text.slice(start, i + 1).trim());
            start = i + 1;
        }
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
    const withoutFences = original.replace(/```[\s\S]*?```/g, ' ');
    const removedFences = withoutFences !== original;
    let sentences = splitSentences(withoutFences);

    let droppedTitleRepeat = false;
    if (
        params.title &&
        sentences.length > 1 &&
        restatesTitle(sentences[0], params.title)
    ) {
        sentences = sentences.slice(1);
        droppedTitleRepeat = true;
    }
    let capped = false;
    if (params.capSentences && sentences.length > 2) {
        sentences = sentences.slice(0, 2);
        capped = true;
    }

    const shaped = sentences.join(' ').trim();
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

export function shapeSuggestionBody(params: {
    body: string;
    title?: string | null;
    capSentences: boolean;
}): string {
    return shapeSuggestionBodyWithReport(params).body;
}
