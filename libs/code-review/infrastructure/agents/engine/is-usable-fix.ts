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
 * guess about style.
 */

export type BadFixReason = 'empty' | 'noop-fix' | 'prose-only' | 'truncated';

/** Any of these appearing outside a comment is enough to call a chunk "code". */
const CODE_TOKEN_RE = /[;{}()=<>]|=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\breturn\b|\bdef\b|\bclass\b/;

function normalizeForComparison(code: string): string {
    return code
        .trim()
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n');
}

/** Line and block comments across the languages this pipeline reviews. */
function stripComments(code: string): string {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|\s)\/\/.*$/gm, ' ')
        .replace(/(^|\s)#.*$/gm, ' ');
}

function isUnbalanced(code: string): boolean {
    const closers: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
    const stack: string[] = [];
    // Comments and string literals can carry stray brackets ("don't}") that
    // are not structural — only the code seen by the language parser counts.
    for (const ch of stripComments(code)) {
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
 * Does the fix stop mid-statement instead of at a clean boundary? A tail
 * line that is blank, a comment, or already ends in punctuation that closes a
 * statement/block/string is treated as clean; anything else — including the
 * literal case from the issue, "...return safe default pa" — is truncation.
 */
function endsMidToken(code: string): boolean {
    const lastLine = code.trimEnd().split('\n').pop() ?? '';
    // A trailing line comment is not part of the statement being judged —
    // "const x = 1; // fixed the off-by-one" ends cleanly at the `;`.
    const withoutTrailingComment = lastLine.replace(/\/\/.*$/, '');
    const trimmed = withoutTrailingComment.trim();
    if (trimmed.length === 0) {
        return false;
    }
    if (/^(\/\/|\*|#)/.test(lastLine.trim())) {
        return false;
    }
    return !/[;{}),\]"'`]$/.test(trimmed);
}

/**
 * Classify why `improvedCode` is not a usable fix for `existingCode`, or
 * `null` when it is fine to publish. Order matters: emptiness and the noop
 * check are cheap and catch the bulk (933 + 30 of 963 in the source data)
 * before the more involved structural checks run.
 */
export function checkFix(
    existingCode: string | null | undefined,
    improvedCode: string | null | undefined,
): BadFixReason | null {
    const existing = (existingCode ?? '').trim();
    const fix = (improvedCode ?? '').trim();

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

    if (normalizeForComparison(fix) === normalizeForComparison(existing)) {
        return 'noop-fix';
    }

    if (!CODE_TOKEN_RE.test(stripComments(fix))) {
        return 'prose-only';
    }

    if (isUnbalanced(fix) || endsMidToken(fix)) {
        return 'truncated';
    }

    return null;
}

/** `true` when `improvedCode` is safe to publish as-is. */
export function isUsableFix(
    existingCode: string | null | undefined,
    improvedCode: string | null | undefined,
): boolean {
    return checkFix(existingCode, improvedCode) === null;
}
