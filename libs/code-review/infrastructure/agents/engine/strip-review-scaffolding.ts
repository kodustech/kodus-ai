/**
 * Turn the reviewer's internal WHAT/WHY/HOW structure into prose, without a
 * model.
 *
 * The finder is INSTRUCTED to produce that structure — see the `writingPolicy`
 * blocks in `review-prompt-blocks.ts`, which tell it to write "1. WHAT: … 2.
 * WHY: … 3. HOW: …". It is scaffolding for the model's own reasoning, and the
 * LLM formatter pass is the only thing that ever converted it into something a
 * person should read.
 *
 * So when that pass produces nothing, the scaffolding ships. Production, twelve
 * hours: 86 of 732 formatter runs (11.7%) returned an empty map, and every
 * suggestion in those batches reached a customer's pull request with the labels
 * intact. The causes were five and unrelated — a suspended account (55), the
 * 90-second ceiling (25), a parse failure, a model id that does not exist, a
 * rate limit — and all five converge on that same empty map.
 *
 * A remote call is the wrong last line of defence for this. Removing three
 * labels is a text operation: it cannot time out, cannot be rate limited, and
 * does not care whether the account has credit. The LLM pass stays what it was
 * — the polish, which reads better — and this becomes the floor under it.
 *
 * Deliberately conservative. It reformats only what it recognises as the
 * template and returns the input untouched otherwise: a suggestion that was
 * already prose must not be rearranged by a fallback.
 */

/**
 * A label, wherever it appears.
 *
 * Matched in every form seen in production rather than only the one the prompt
 * asks for: at the start of a line, or mid-sentence ("WHAT: x. WHY: y. HOW: z."
 * on a single line is common); with or without the numbered prefix; and with
 * markdown emphasis models add unprompted — including `**WHAT:**`, where the
 * emphasis closes AFTER the colon.
 *
 * Matching the numbered prefix as part of the label is what keeps a bare "1."
 * from surviving as its own fragment.
 */
const LABEL_ANYWHERE =
    /(?:^|\n|(?<=\S)[ \t]+)(?:\d+[.)][ \t]*)?(?:\*\*|__)?[ \t]*(?:WHAT|WHY|HOW)[ \t]*(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*/gi;

/** A control character, so it can never collide with the content itself. */
const SENTINEL = '\u0001';

/**
 * Fenced code is source, not prose: a `WHY:` inside a code block is something
 * the reviewer is quoting, and rewriting it would corrupt the example.
 */
const outsideFences = (
    content: string,
    transform: (chunk: string) => string,
): string =>
    content
        .split(/(```[\s\S]*?```)/g)
        .map((chunk, i) => (i % 2 === 1 ? chunk : transform(chunk)))
        .join('');

const mark = (content: string): string =>
    outsideFences(content, (chunk) =>
        chunk.replace(LABEL_ANYWHERE, SENTINEL),
    );

export function looksLikeReviewScaffolding(content: string): boolean {
    if (!content) {
        return false;
    }
    // WHAT alone is enough: the prompt makes HOW optional ("omit if
    // speculative"), and a finding that leaked only the first label is just as
    // wrong to ship.
    return mark(content).includes(SENTINEL);
}

/**
 * Strip the labels and join what they delimited into a paragraph.
 *
 * The parts are already one sentence each by construction ("one sentence naming
 * the exact problem", "one sentence on the real impact"), so joining them
 * produces the shape the formatter was asked to produce. No rewording is
 * attempted — inventing prose without a model is how a fallback starts saying
 * things the reviewer did not.
 */
export function stripReviewScaffolding(content: string): string {
    if (!looksLikeReviewScaffolding(content)) {
        return content;
    }

    const joined = mark(content)
        .split(SENTINEL)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            // A part carrying a code fence keeps its line breaks; a fence
            // flattened onto one line is no longer a fence.
            if (part.includes('```')) {
                return part;
            }
            const flat = part.replace(/\s+/g, ' ').trim();
            return /[.!?:;]$/.test(flat) ? flat : `${flat}.`;
        })
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim();

    // If stripping somehow emptied the content, keep the original: a labelled
    // suggestion is bad, an empty one is worse.
    return joined || content;
}
