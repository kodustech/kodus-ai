/**
 * Deterministic publication gate for `improvedCode` (issue #1833).
 *
 * Four weeks of production thumbs-down: 963 of 2,515 (38%) had no usable fix —
 * 933 empty, 30 byte-identical to `existingCode`. Nothing in the pipeline
 * checks CONTENT before a suggestion ships: `kody-rules-sharded.judge.ts`
 * allows the model to return `improvedCode: null` when a fix "cannot be
 * expressed as a replacement", the generalist finder schema requires the
 * field but not that it be usable, and `validate-suggestions.stage.ts` only
 * decides whether a fix gets GitHub's "Apply" button — never whether it
 * should ship at all. A wrong diagnosis reads as a miss; a right diagnosis
 * with an empty or identical "fix" reads as OUR mistake.
 *
 * Scope is deliberately narrower than the issue's original four buckets
 * (empty / identical / prose-only / truncated). A "prose-only" classifier —
 * does this text read as English or as code? — went through seven review
 * rounds of keyword lists, stop-word gates, and label vocabularies, and each
 * fix for one false positive (real code wrongly dropped) opened a new false
 * negative (prose wrongly shipped) or vice versa: there is no regex that
 * reliably tells "enabled" apart from "warning", or "await the response"
 * from "await(response)". That is not a bug to keep patching — it is
 * evidence the classification itself is not decidable this way. Dropped
 * entirely rather than kept as an ever-more-elaborate heuristic. What
 * remains is checkable without judging whether text "looks like" code:
 * empty, byte-for-byte (whitespace-normalized) identical to `existingCode`,
 * or syntactically broken (unbalanced brackets/quotes, a dangling operator,
 * a diff hunk, a stray list marker) — each of those is true or false of the
 * TEXT ITSELF, never a guess about what a human would call it.
 *
 * Known scope boundary: Ruby's `do`/`end` block delimiters are not tracked
 * as a bracket pair the way `{}()[]` are, so a Ruby fix truncated mid-block
 * (a `do` with no matching `end`) is caught only if it ALSO leaves a bracket
 * or quote unbalanced. Deliberately not attempted: unlike a bracket
 * character, `end` collides with ordinary Ruby identifier use (`range.end`,
 * a method literally named `end`), so counting it the way `{`/`}` are
 * counted would misfire on real, unrelated code — the same class of harm
 * the rest of this file works hard to avoid elsewhere.
 *
 * Known scope boundary: a label glued onto an otherwise-identical fix
 * (`"Fix: return x;"` for `existingCode` `"return x;"`) is NOT caught by the
 * noop check — `normalizeForComparison` does not strip a leading `"Fix: "`,
 * `"Note: "`, etc. before comparing. An earlier version of this file did
 * strip such labels, via a fixed English word list; that list is exactly the
 * prose-vocabulary approach this file's design note above rejects — it never
 * matched a pt-BR (or any non-English) review config's own labels, and
 * "which words count as a label" is not decidable any more deterministically
 * than "which text reads as English" was. Left uncaught rather than
 * resurrected as an ever-growing, still-incomplete word list.
 */

export type BadFixReason = 'empty' | 'noop-fix' | 'truncated';

/**
 * Quoted string / template-literal spans, escape-aware. Capturing group so
 * `.split()` interleaves [nonLiteral, literal, nonLiteral, ...] — string
 * CONTENT has its own semantics (a whitespace or bracket character inside a
 * string is data, not structure) and the checks below need to treat it
 * differently from the surrounding code.
 *
 * Forms recognized, in match-priority order (triple-quotes MUST precede the
 * single/double branches — otherwise `"""x"""` reads as an empty `""`
 * literal immediately followed by unprotected code, then another empty
 * `""`, which is exactly wrong):
 *   - `"""..."""` / `'''...'''` — Python triple-quoted strings.
 *   - `"..."` / `'...'` — the single-quote branch matches an ARBITRARY-length
 *     run, correct for JavaScript/TypeScript/Python/Ruby/PHP.
 *   - `` `...` `` — JS/TS template literals.
 *   - `“...”` / `‘...’` — typographic/"smart" quotes. Not a programming-
 *     language construct, but a model with autocorrect-flavored output can
 *     emit them inside what is otherwise real code, and an unprotected `“`
 *     or `”` reads no differently to the checks below than a straight one.
 *   - `%w[...]` / `%i[...]` / `%q{...}` / `%Q{...}` — Ruby's `%`-literals,
 *     bracket/brace-delimited forms (by far the most common in the wild;
 *     the arbitrary-delimiter general form is not attempted).
 */
const STRING_LITERAL_RE =
    /("""(?:[^\\]|\\.)*?"""|'''(?:[^\\]|\\.)*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|“[^”]*”|‘[^’]*’|%[wiqQ]\[[^\]]*\]|%[qQ]\{[^}]*\})/g;

/**
 * Rust's `'` is NOT reserved for strings: a lifetime (`&'a str`,
 * `fn f<'a>(..)`) opens with `'` and is never closed by a matching quote. The
 * general regex above pairs the FIRST such `'` with whatever `'` comes next —
 * typically a second, unrelated lifetime on the same line — and swallows
 * everything between them, including real code, as if it were string content.
 * `fn parse<'a>(input: &'a str) -> Result<&'a str, Error>` loses its opening
 * `(` this way. Rust's actual single-quote construct, a char literal, is
 * always exactly one character or one escape (`'a'`, `'\n'`, `'\''`), so that
 * is all this variant's single-quote branch accepts; a lifetime marker simply
 * never matches it and is left as ordinary code. Every other form (triple-
 * quotes, template literals, smart quotes, Ruby `%`-literals) is kept for
 * parity even though Rust source will not produce them — a language switch
 * with an incomplete twin is how a variant silently rots.
 */
const STRING_LITERAL_RE_RUST =
    /("""(?:[^\\]|\\.)*?"""|'''(?:[^\\]|\\.)*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'|`(?:[^`\\]|\\.)*`|“[^”]*”|‘[^’]*’|%[wiqQ]\[[^\]]*\]|%[qQ]\{[^}]*\})/g;

function stringLiteralRegexFor(language: string | undefined): RegExp {
    return (language ?? '').trim().toLowerCase() === 'rust'
        ? STRING_LITERAL_RE_RUST
        : STRING_LITERAL_RE;
}

/**
 * Captures the bare-word run after a trailing `return`/`yield` (see
 * `isStructurallyBroken`'s truncated-return-value check below).
 */
const RETURN_TAIL_WORD_RUN_RE =
    /\b(?:return|yield)\s+([A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)+)\s*$/;

/**
 * A word-form logical/comparison operator or clause keyword. Python
 * especially spells several operators as bare words rather than symbols
 * (`and`/`or`/`not`/`is`/`in`), and both Python's conditional expression
 * (`x if y else z`) and `yield from` are also bare-word forms — every one
 * of these is a real, COMPLETE multi-word return value, not a truncated
 * one. If the captured word run contains any of these, the bare-word-run
 * check does not apply; "return safe default pa" contains none of them and
 * is still caught.
 */
const LOGICAL_CONNECTOR_WORD_RE =
    /\b(?:and|or|not|is|in|if|else|elif|from|for|while|as|with|lambda)\b/;

/**
 * Same word list as `LOGICAL_CONNECTOR_WORD_RE`, but anchored to the END of
 * the captured run. A connector word appearing mid-run ("x if y else z") is
 * what makes the whole thing a complete expression; the SAME word dangling
 * at the very end ("return a if", "return x and") is the opposite — every
 * one of these connectors requires an operand after it in every supported
 * language, so a run ending in one is truncated exactly like the plain
 * word-run case, not exempt from it.
 */
const CONNECTOR_TAIL_RE =
    /\b(?:and|or|not|is|in|if|else|elif|from|for|while|as|with|lambda)\s*$/;

/** Apply `transform` only to the parts of `code` OUTSIDE string literals. */
function outsideStringLiterals(
    code: string,
    language: string | undefined,
    transform: (chunk: string) => string,
): string {
    return code
        .split(stringLiteralRegexFor(language))
        .map((chunk, i) => (i % 2 === 1 ? chunk : transform(chunk)))
        .join('');
}

/** Drop string-literal CONTENT entirely (kept only for structural scans). */
function stripStringLiterals(code: string, language: string | undefined): string {
    return code
        .split(stringLiteralRegexFor(language))
        .map((chunk, i) => (i % 2 === 1 ? '' : chunk))
        .join('');
}

/**
 * Collapse whitespace runs to one space/newline, but not inside a string
 * literal — `"hello   world"` → `"hello world"` is a real content change
 * (fixing a double space in a user-facing message), not a formatting no-op,
 * so it must not compare equal to the original.
 */
function normalizeForComparison(code: string, language: string | undefined): string {
    return outsideStringLiterals(code.trim(), language, (chunk) =>
        chunk.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n'),
    );
}

/**
 * Line and block comments across the languages this pipeline reviews. Must
 * only ever be run on text that is ALREADY known to be outside a string
 * literal (see `outsideStringLiterals`) — `#` and `//` are valid message
 * content ("Error #1 occurred", a URL), and running this directly on raw
 * code that still contains string literals eats into them: `#1 occurred"`
 * gets read as a line comment and stripped, taking the closing quote with
 * it and leaving what looks like an unterminated string behind.
 */
function stripComments(code: string): string {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|\s)\/\/.*$/gm, ' ')
        .replace(/(^|\s)#.*$/gm, ' ');
}

/**
 * A JS/TS regex literal (`/["']/g`, `/^\d+$/`) is neither a string nor a
 * comment, but its content is just as opaque — the quote characters inside
 * `/["']/g` are a character class, not an unterminated string, and the `[`/
 * `]` are regex syntax, not real brackets. Left unstripped, a fix that adds
 * a perfectly valid quote-matching regex registered as "truncated": the
 * exact false-positive this file's header says it must avoid.
 *
 * Gated on what can precede a regex literal (assignment, open paren, comma,
 * colon, start of text, or "return") and never a division operand — the
 * standard regex-vs-divide disambiguation every JS tokenizer needs, so
 * `total / count` is never mistaken for the start of one.
 */
const REGEX_LITERAL_RE =
    /(^|[=(,:]|\breturn)(\s*)(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g;

function stripRegexLiterals(code: string): string {
    return code.replace(REGEX_LITERAL_RE, (_m, pre: string, ws: string) => pre + ws);
}

/**
 * Is `code` structurally broken — brackets that don't close, a string
 * literal that never does, or a tail that cannot end a statement in any
 * supported language? All three are strong, language-agnostic truncation
 * signals: a model cut off mid-generation almost always stops before closing
 * whatever it was in the middle of writing, or mid-expression.
 *
 * Order matters and was itself a bug the first time this was written: strip
 * comments OUTSIDE string literals first (so `#`/`//` living inside a string
 * is never mistaken for a comment marker), and only THEN strip the now-intact
 * literal spans for the bracket scan — `const s = "x)"` has a `)` that is
 * data, not a closer, and counting it made a one-line fix with a parenthesis
 * in its message text register as unbalanced. Regex literals are stripped
 * from that same text, for the same reason string literals are.
 *
 * A leftover `'` is NOT treated as an unterminated literal for Rust — that
 * character is legitimately part of a lifetime marker there and never closes
 * by design (see `STRING_LITERAL_RE_RUST`), so it carries no truncation
 * signal for that language the way it does everywhere else.
 */
function isStructurallyBroken(code: string, language: string | undefined): boolean {
    const withoutComments = outsideStringLiterals(code, language, stripComments);
    // Everything left over after every COMPLETE literal is removed.
    const nonLiteral = stripRegexLiterals(
        stripStringLiterals(withoutComments, language),
    );

    // A tail that cannot end a statement in ANY supported language — a bare
    // binary/assignment operator, a dangling "?"/":"/",", or an arrow with
    // nothing after it. Checked against `withoutComments` (literal CONTENT
    // still intact), not the fully-stripped `nonLiteral`: removing a
    // TRAILING literal's content shifts what character is now "last" and
    // can make an operator that precedes it look dangling by accident —
    // "list = %w[a b]" ends in "]", but stripping the %w[] content down to
    // nothing leaves the "=" sitting at the new end, registering as
    // truncated. Bare "<"/">" are deliberately asymmetric: "<" with nothing
    // after is always an incomplete generic/comparison, but ">" alone is
    // routinely how a real, COMPLETE generic type ends ("Result<T, E>",
    // Rust/TypeScript/Java/C#), so only the 2-char arrow "=>" counts, not a
    // bare trailing ">".
    if (/[=+\-*&|?:,<]\s*$|=>\s*$/.test(withoutComments.trimEnd())) {
        return true;
    }
    // "return"/"yield" followed by 2+ bare, unseparated words is a syntax
    // error in every supported language regardless of truncation — a return
    // value is a single expression, not a word run — and is the issue's own
    // literal motivating example ("...return safe default pa"). Scoped to
    // return/yield specifically, not any bare-word run: a general rule
    // collides with real multi-keyword declarations valid in several of
    // these languages ("var x int" in Go, "public static void" in Java).
    // Checked against `withoutComments` for the same reason as above.
    //
    // Excludes a word run containing a word-form operator/keyword
    // (LOGICAL_CONNECTOR_WORD_RE) — without this, "yield from gen",
    // "return not x", and "return x if y else z" (all valid, COMPLETE
    // Python) matched the same shape as the truncated example and were
    // silently dropped as "truncated", the opposite of this file's purpose.
    // That exemption is narrowed back by CONNECTOR_TAIL_RE: the connector
    // has to appear mid-run, not be the LAST word — "return a if" and
    // "return x and" dangle the same way "return safe default pa" does,
    // just with a keyword instead of an identifier, and every one of these
    // connectors requires an operand after it in every supported language.
    const returnTailMatch = RETURN_TAIL_WORD_RUN_RE.exec(withoutComments.trimEnd());
    if (
        returnTailMatch &&
        (!LOGICAL_CONNECTOR_WORD_RE.test(returnTailMatch[1]) ||
            CONNECTOR_TAIL_RE.test(returnTailMatch[1]))
    ) {
        return true;
    }

    const isRust = (language ?? '').trim().toLowerCase() === 'rust';
    for (const ch of nonLiteral) {
        if (ch === '"' || ch === '`') {
            return true;
        }
        if (ch === "'" && !isRust) {
            return true;
        }
    }

    const closers: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
    const stack: string[] = [];
    for (const ch of nonLiteral) {
        if (ch === '{' || ch === '(' || ch === '[') {
            stack.push(ch);
        } else if (ch in closers) {
            if (stack.pop() !== closers[ch]) {
                return true;
            }
        }
    }
    return stack.length > 0;
}

/**
 * Is `code` a unified-diff hunk (every line starting with "-"/"+") rather
 * than plain replacement code? `improvedCode`'s contract is "ready to
 * apply" — pasting a hunk in verbatim inserts diff markers into the source
 * file, which is invalid in every language reviewed here, even though the
 * text itself is otherwise well-formed (balanced brackets, real code
 * tokens) and would sail past every other check in this file. Requiring
 * BOTH a "-" line and a "+" line is what makes this specific to diff
 * output — a single-line fix that starts with "-" is ordinary negation
 * (`-x`) and is unaffected (fewer than 2 lines short-circuits below).
 */
function looksLikeDiffHunk(code: string): boolean {
    const lines = code
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length < 2) {
        return false;
    }
    const allMarked = lines.every(
        (line) => line.startsWith('-') || line.startsWith('+'),
    );
    return (
        allMarked &&
        lines.some((line) => line.startsWith('-')) &&
        lines.some((line) => line.startsWith('+'))
    );
}

/**
 * Does `code` open with a markdown ordered-list marker ("1. ", "2) ")? A
 * fix's own place in an explanatory numbered list sometimes leaks into the
 * dedicated `improvedCode` field instead of staying in `suggestionContent` —
 * "1. const x = 2;" is otherwise perfectly valid code, but applying it
 * verbatim inserts "1. " into the source, invalid in every language
 * reviewed here.
 *
 * Anchored so a decimal literal never collides: "1.5 * x" has no whitespace
 * between the "." and the "5", which this requires after the marker.
 */
function startsWithListMarker(code: string): boolean {
    return /^\s*\d+[.)]\s+\S/.test(code);
}

/**
 * Classify why `improvedCode` is not a usable fix for `existingCode`, or
 * `null` when it is fine to publish. Order matters: emptiness and the noop
 * check are cheap and catch the bulk (933 + 30 of 963 in the source data)
 * before the more involved structural checks run.
 *
 * `language` (the finding's own `CodeSuggestion.language`) is optional and
 * only changes how a single-quote character is read — everything else is
 * language-agnostic by construction. Omitting it is always safe: it just
 * falls back to the general (non-Rust) reading.
 */
export function checkFix(
    existingCode: string | null | undefined,
    improvedCode: string | null | undefined,
    language?: string | null,
): BadFixReason | null {
    const existing = (existingCode ?? '').trim();
    const fix = (improvedCode ?? '').trim();
    const lang = language ?? undefined;

    // No anchor code at all: a PR-level/whole-file Kody Rule finding (the
    // judge's own schema allows `existingCode: null` there — see
    // kody-rules-sharded.judge.ts) or an envelope truncated before any code
    // survived. There is nothing for `improvedCode` to be a replacement OF,
    // so an empty fix here is expected, not unusable — other parts of the
    // pipeline (the PR-level split, the missing-relevantFile guard) already
    // decide what happens to these.
    if (!existing) {
        return null;
    }

    if (!fix) {
        return 'empty';
    }

    if (normalizeForComparison(fix, lang) === normalizeForComparison(existing, lang)) {
        return 'noop-fix';
    }

    if (
        isStructurallyBroken(fix, lang) ||
        looksLikeDiffHunk(fix) ||
        startsWithListMarker(fix)
    ) {
        return 'truncated';
    }

    return null;
}

/** `true` when `improvedCode` is safe to publish as-is. */
export function isUsableFix(
    existingCode: string | null | undefined,
    improvedCode: string | null | undefined,
    language?: string | null,
): boolean {
    return checkFix(existingCode, improvedCode, language) === null;
}
