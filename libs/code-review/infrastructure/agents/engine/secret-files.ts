import { posix } from 'node:path';

import { isFileMatchingGlobCaseInsensitive } from '@libs/common/utils/glob-utils';

/**
 * Files that hold credentials when a repository commits them: env files,
 * private keys and keystores. Their content would reach the model provider
 * and the review's trace, so no agent tool returns it.
 */
export const SECRET_FILE_GLOBS = [
    '**/.env*',
    '**/*.pem',
    '**/*.key',
    '**/*.p12',
    '**/*.pfx',
    '**/*.jks',
    '**/*.keystore',
    '**/id_rsa*',
    '**/id_dsa*',
    '**/id_ecdsa*',
    '**/id_ed25519*',
];

/** Env file templates: variable names, not values. */
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i;

export function isSecretFilePath(filePath: string): boolean {
    // The sandbox resolves `a/./b` and `a/../b`: every spelling is one file.
    const normalized = posix.normalize(filePath).replace(/^\.?\/+/, '');
    if (!normalized || ENV_TEMPLATE.test(normalized)) return false;
    return isFileMatchingGlobCaseInsensitive(normalized, SECRET_FILE_GLOBS);
}

export function secretFileRefusal(filePath: string): string {
    return `${filePath} is a secret file (credentials or keys); its content is not shown.`;
}

/**
 * Drops the lines of grep output that come from a secret file. rg prints
 * `path:line:text` for a match and `path-line-text` for a context line;
 * with namesOnly, the bare path; a linked repository's lines carry its tag. A path can hold ":" or "-" itself, so every
 * candidate prefix ending before a line number is tested.
 */
export function withoutSecretFileLines(output: string): string {
    const lines = output.split('\n');
    const kept = lines.filter((line) => !lineFromSecretFile(line));
    if (kept.length === lines.length) return output;
    // A `--` group separator is kept only between two groups that remain.
    const out: string[] = [];
    for (const line of kept) {
        if (line === '--' && (!out.length || out[out.length - 1] === '--')) {
            continue;
        }
        out.push(line);
    }
    if (out[out.length - 1] === '--') out.pop();
    return out.join('\n');
}

/** Linked-repository grep tags each line with `[owner/repo] `. */
const REPOSITORY_TAG = /^\[[^\]\s]+\] /;

/**
 * rg prints the path first, and no path is longer than this: a boundary
 * further in is inside the matched text. Without this bound every boundary
 * of a long line (minified code, data files) re-tested the whole prefix,
 * O(length x boundaries): a 135 KB line held the worker for 21s and a
 * 291 KB one for 181s, until the ECS health check killed it (Nov 2026).
 */
const MAX_PATH_LENGTH = 4096;

/**
 * The last path segment every pattern in SECRET_FILE_GLOBS requires: a
 * cheap screen so only a plausible prefix pays for the full glob match.
 */
const SECRET_BASENAME =
    /^(?:\.env|id_(?:rsa|dsa|ecdsa|ed25519))|\.(?:pem|key|p12|pfx|jks|keystore)$/i;

const isSeparator = (c: number) => c === 47 || c === 92; // `/` or `\\`

/**
 * Whether the path that ends at `end` could be a secret file: a cheap screen
 * on its last segment before the glob. `lastSep` is the last separator
 * before `end` (isSecretFilePath reads `\\` as one too), kept by the caller
 * as it walks the line, so no boundary scans the prefix again.
 */
function mightBeSecretPrefix(
    line: string,
    lastSep: number,
    end: number,
): boolean {
    const base = line.slice(lastSep + 1, end);
    if (base !== '' && base !== '.' && base !== '..') {
        return SECRET_BASENAME.test(base);
    }
    // A trailing slash or `.` names the segment before it: walk back over
    // separators and `.` segments, then over that segment only.
    let k = end;
    for (;;) {
        while (k > 0 && isSeparator(line.charCodeAt(k - 1))) k--;
        if (
            k > 0 &&
            line.charCodeAt(k - 1) === 46 /* . */ &&
            (k === 1 || isSeparator(line.charCodeAt(k - 2)))
        ) {
            k -= 1;
            continue;
        }
        break;
    }
    let start = k;
    while (start > 0 && !isSeparator(line.charCodeAt(start - 1))) start--;
    const last = line.slice(start, k);
    // `..` (or nothing left): only normalization knows the segment.
    if (last === '' || last === '..') return true;
    return SECRET_BASENAME.test(last);
}

function lineFromSecretFile(tagged: string): boolean {
    const line = tagged.replace(REPOSITORY_TAG, '');
    const boundary = /[:-]\d+[:-]/g;
    let match: RegExpExecArray | null;
    let prefixed = false;
    // The last separator before the current boundary, found by one forward
    // pass over the line (boundaries come in order).
    let scanned = 0;
    let lastSep = -1;
    while ((match = boundary.exec(line))) {
        prefixed = true;
        if (match.index > MAX_PATH_LENGTH) break;
        for (; scanned < match.index; scanned++) {
            if (isSeparator(line.charCodeAt(scanned))) lastSep = scanned;
        }
        if (
            mightBeSecretPrefix(line, lastSep, match.index) &&
            isSecretFilePath(line.slice(0, match.index))
        )
            return true;
    }
    // A bare path (namesOnly). A match line is judged by its path alone:
    // its text can end in `.pem` too.
    return !prefixed && isSecretFilePath(line.trim());
}
