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
 * This is a text check on two strings, deliberately conservative: false
 * positives here silently drop a real fix, so each rule requires the kind of
 * evidence a human reviewing the raw pair would call obviously wrong, not a
 * guess about style. This codebase reviews 9 languages (see
 * `SupportedLanguages.ts`), and the checks below were tuned against real
 * examples from each of them, not just semicolon-terminated JS/TS — see the
 * per-check notes for the specific cases that shaped each one.
 *
 * Known scope boundary: Ruby's `do`/`end` block delimiters are not tracked
 * as a bracket pair the way `{}()[]` are, so a Ruby fix truncated mid-block
 * (a `do` with no matching `end`) is caught only if it ALSO leaves a bracket
 * or quote unbalanced. Deliberately not attempted: unlike a bracket
 * character, `end` collides with ordinary Ruby identifier use (`range.end`,
 * a method literally named `end`), so counting it the way `{`/`}` are
 * counted would misfire on real, unrelated code — the same class of harm
 * the rest of this file works hard to avoid elsewhere.
 */

export type BadFixReason = 'empty' | 'noop-fix' | 'prose-only' | 'truncated';

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
 * Any of these appearing outside a comment is enough to call a chunk "code".
 * Punctuation first (quotes/colon/brackets/arrows) because it barely ever
 * appears in a plain-English sentence describing a fix, which is what makes
 * it a safe signal across every language this pipeline reviews — unlike a
 * keyword list, which is inherently one language's vocabulary at a time and
 * runs out for the next one (a bare Python `import os` or `elif x:` has none
 * of function/const/let/var/return/def/class).
 *
 * Deliberately NOT included: a dotted-access pattern (`\.\w`, e.g. "x.y").
 * That one first looked like a safe method/property-access signal but a
 * sentence prose commonly NAMES a property this way too ("check user.active
 * before granting access"), and that turned a real prose-only fix into a
 * false "usable" verdict — worse than the gap it was meant to close.
 *
 * The keyword list stays SHORT and deliberately excludes common English words
 * (for/new/try/case/while/throw/switch/else/from/include/require all lost
 * this bid) — accepting one of those as a "code" token lets genuine prose
 * slip through as if it were a real fix, which is the harm on the OTHER side
 * of this check and just as bad as a false positive.
 */
const CODE_TOKEN_RE =
    /[;{}()[\]=<>:]|=>|->|::|["'`]|\b(?:function|const|let|var|return|def|elif|class|import|async|await|yield|attr_reader)\b/;

/**
 * A short leading label — "Fix:", "Note:", "**WHY:**" — immediately followed
 * by ":" is a prose lead-in, not a code colon, and CODE_TOKEN_RE's bare `:`
 * cannot tell them apart from a Python/Ruby block-opener or a `key: value`
 * pair. This is the SAME leak `strip-review-scaffolding.ts` documents for
 * `suggestionContent` (the review prompt's own WHAT/WHY/HOW template) landing
 * in `improvedCode` instead: "**Fix:** add a null check before line 5" has a
 * colon and registered as usable code with nothing else in this file to stop
 * it. Scoped to this SPECIFIC label vocabulary, not any short word, so a
 * genuine one-line dict/object pair like "key: value" keeps registering as
 * code — only the words this codebase's own review prompts are known to
 * produce as scaffolding labels are excluded.
 */
const PROSE_LABEL_LEAD_RE =
    /^(?:\*\*|__)?(?:fix|note|why|how|what|issue|bug|problem|solution|suggestion|recommendation|explanation|reason|cause|summary)(?:\*\*|__)?:\s*/i;

/**
 * A handful of control-flow statements that are, on their own, complete and
 * valid in several supported languages — Python's bare `pass`/`break`/
 * `continue`/`raise`, Ruby's `next`/`redo`/`retry`, Go's `fallthrough` — and
 * carry NEITHER punctuation nor a CODE_TOKEN_RE keyword, so a fix that is
 * exactly one of these words alone would otherwise register as prose-only.
 * "break" itself was excluded from CODE_TOKEN_RE for colliding with ordinary
 * English ("this would break the tests"), but that risk only exists mid-
 * sentence — gating on the fix being EXACTLY this one word and nothing else
 * is safe: prose is not shaped like a single bare word.
 */
const BARE_STATEMENT_RE =
    /^(?:break|continue|pass|raise|next|redo|retry|fallthrough)[;:]?$/;

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
 * Is `code` structurally broken — brackets that don't close, or a string
 * literal that never does? Both are strong, language-agnostic truncation
 * signals: a model cut off mid-generation almost always stops before closing
 * whatever it was in the middle of writing.
 *
 * Order matters and was itself a bug the first time this was written: strip
 * comments OUTSIDE string literals first (so `#`/`//` living inside a string
 * is never mistaken for a comment marker), and only THEN strip the now-intact
 * literal spans for the bracket scan — `const s = "x)"` has a `)` that is
 * data, not a closer, and counting it made a one-line fix with a parenthesis
 * in its message text register as unbalanced.
 *
 * A leftover `'` is NOT treated as an unterminated literal for Rust — that
 * character is legitimately part of a lifetime marker there and never closes
 * by design (see `STRING_LITERAL_RE_RUST`), so it carries no truncation
 * signal for that language the way it does everywhere else.
 */
function isStructurallyBroken(code: string, language: string | undefined): boolean {
    const withoutComments = outsideStringLiterals(code, language, stripComments);
    // Everything left over after every COMPLETE literal is removed.
    const nonLiteral = stripStringLiterals(withoutComments, language);

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

    const tokenView = outsideStringLiterals(fix, lang, stripComments)
        .replace(PROSE_LABEL_LEAD_RE, '')
        .trim();
    if (!CODE_TOKEN_RE.test(tokenView) && !BARE_STATEMENT_RE.test(tokenView)) {
        return 'prose-only';
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
