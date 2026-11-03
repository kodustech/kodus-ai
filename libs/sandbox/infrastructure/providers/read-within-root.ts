import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';

/**
 * sed's address for a 1-based line range. The values come from a model's tool
 * call, and sed's `w` writes a file and GNU sed's `e` runs a program, so only
 * line numbers are accepted. `start = end = 0` is the whole file and has no
 * address: GNU sed rejects line 0.
 */
export function sedLineRange(start: number, end: number): string {
    if (!isLineNumber(start) || !isLineNumber(end)) {
        throw new Error(
            `Invalid line range ${JSON.stringify(start)},${JSON.stringify(end)}: startLine and endLine must be non-negative integers`,
        );
    }
    return `${start < 1 ? 1 : start},${end}p`;
}

export function isLineNumber(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * A shell command that prints a file of a checkout, or a line range of it,
 * without following a symlink: `cat` alone follows one anywhere in the
 * sandbox, to files of other processes included. Like the local sandbox's
 * resolveSafePath, the file itself must not be a symlink and its real path
 * must stay under the root. `start = end = 0` prints the whole file.
 */
export function readWithinRootCommand(
    abs: string,
    root: string,
    start: number,
    end: number,
): string {
    const print =
        start === 0 && end === 0
            ? 'cat "$p"'
            : `sed -n '${sedLineRange(start, end)}' "$p"`;
    return [
        `f=${shSingleQuote(abs)}`,
        `r=$(realpath ${shSingleQuote(root)}) || exit 1`,
        `if [ -L "$f" ]; then echo "Symlink detected, refusing to follow: $f" >&2; exit 1; fi`,
        `p=$(realpath "$f") || exit 1`,
        `case "$p" in "$r"/*) ;; *) echo "Path escapes repo boundary: $f" >&2; exit 1 ;; esac`,
        print,
    ].join('; ');
}
