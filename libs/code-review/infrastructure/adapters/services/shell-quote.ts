/**
 * Wrap a value in single quotes for safe inclusion in a POSIX shell command.
 *
 * Anything a PR author can influence (filenames, branch names, ref names,
 * function names extracted from the diff) may contain shell-control tokens —
 * `;`, `&&`, `|`, `$()`, backticks. Double-quoted interpolation still expands
 * most of those, so string-building commands must go through this helper.
 *
 * Escapes embedded apostrophes using the classic `'\''` idiom (close quote,
 * escaped single quote, reopen quote).
 */
export const shSingleQuote = (value: string): string =>
    `'${value.replace(/'/g, "'\\''")}'`;
