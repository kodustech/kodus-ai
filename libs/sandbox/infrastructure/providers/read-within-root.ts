import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';

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
            : `sed -n '${start < 1 ? 1 : start},${end}p' "$p"`;
    return [
        `f=${shSingleQuote(abs)}`,
        `r=$(realpath ${shSingleQuote(root)}) || exit 1`,
        `if [ -L "$f" ]; then echo "Symlink detected, refusing to follow: $f" >&2; exit 1; fi`,
        `p=$(realpath "$f") || exit 1`,
        `case "$p" in "$r"/*) ;; *) echo "Path escapes repo boundary: $f" >&2; exit 1 ;; esac`,
        print,
    ].join('; ');
}
