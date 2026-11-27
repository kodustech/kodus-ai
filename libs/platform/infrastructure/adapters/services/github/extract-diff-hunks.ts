/**
 * Pulls per-file hunks out of a raw unified diff.
 *
 * Consumers expect the same shape GitHub's file listing gives in `patch`:
 * the hunks alone, starting at the first `@@`, without the `diff --git`,
 * `index`, `---` and `+++` headers.
 */
export function extractDiffHunks(
    diff: string,
    paths: string[],
): Array<{ path: string; patch: string }> {
    if (!diff || !paths.length) {
        return [];
    }

    const wanted = new Set(paths);
    const out: Array<{ path: string; patch: string }> = [];

    // Split on the file headers rather than scanning line by line: a lockfile
    // diff can be hundreds of thousands of lines, and its CONTENT can contain
    // anything — including lines that look like headers.
    const sections = diff.split(/^diff --git /m).slice(1);

    for (const section of sections) {
        const header = section.slice(0, section.indexOf('\n'));
        // `a/<path> b/<path>`. git quotes a header only when the path holds a
        // non-ASCII byte, a quote or a backslash, so an accented lockfile would
        // otherwise be skipped without a word. A plain path can itself contain
        // " b/", which leaves more than one place to cut the header: the
        // candidates are offered to the caller, which knows the paths it wants.
        const path = headerPaths(header, section).find((candidate) =>
            wanted.has(candidate),
        );
        if (!path) {
            continue;
        }

        const firstHunk = section.indexOf('\n@@');
        if (firstHunk === -1) {
            // A rename or mode change with no content diff carries no hunks.
            continue;
        }

        // Only the newline(s) the split left behind. `trimEnd()` would eat
        // trailing spaces or tabs on the last content line, and a patch that
        // no longer matches the checkout makes `revertPatch` return null —
        // the baseline is discarded and the scan reports nothing.
        out.push({
            path,
            patch: section.slice(firstHunk + 1).replace(/\n+$/, ''),
        });
    }

    return out;
}

/**
 * How many separator candidates a header without `---`/`+++` lines may offer.
 * A crafted path full of " b/" would otherwise copy the tail once per opener.
 */
const MAX_HEADER_CANDIDATES = 64;

/**
 * The paths a `diff --git` header can name, best reading first.
 *
 * git writes `a/<old> b/<new>` and only quotes the header when a path holds a
 * non-ASCII byte, a quote or a backslash. A plain path that itself contains
 * " b/" therefore leaves more than one place to cut the header, and the
 * earliest cut shortens the path: `a/fixtures b/package-lock.json b/fixtures
 * b/package-lock.json`.
 *
 * The section's own `---` and `+++` lines name the two sides exactly, so they
 * are read first and a cut is only guessed when they are absent. For a rename
 * only the new path is offered: the hunks of a renamed file belong to that
 * file, not to a different file the caller asked for under the old name.
 */
function headerPaths(header: string, section: string): string[] {
    const firstHunk = section.indexOf('\n@@');
    const head = firstHunk === -1 ? section : section.slice(0, firstHunk);
    const minus = /^--- (.+)$/m.exec(head);
    const plus = /^\+\+\+ (.+)$/m.exec(head);
    const oldPath = minus ? sidePathOf(minus[1], 'a/') : undefined;
    const newPath = plus ? sidePathOf(plus[1], 'b/') : undefined;

    if (newPath) {
        return [newPath];
    }
    if (oldPath) {
        // A deletion has no new side, and its hunks still belong to this path.
        return [oldPath];
    }

    const quoted = header.match(/^"a\/(.+?)" "b\/(.+)"$/);
    if (quoted) {
        const quotedNew = unescapeGitPath(quoted[2]);
        return [quotedNew];
    }

    if (!header.startsWith('a/')) {
        return [];
    }

    const body = header.slice(2);
    const renamed: string[] = [];
    for (
        let at = body.indexOf(' b/');
        at !== -1 && renamed.length < MAX_HEADER_CANDIDATES;
        at = body.indexOf(' b/', at + 1)
    ) {
        const cutOld = body.slice(0, at);
        const cutNew = body.slice(at + 3);
        // Two sides that agree are the path, and no later cut can improve it.
        if (cutOld === cutNew) {
            return [cutNew];
        }
        renamed.push(cutNew);
    }

    // Only a rename header with no ---/+++ lines reaches this point.
    return renamed.length ? [renamed[0]] : [];
}

/**
 * One side of a `---`/`+++` line: `a/foo`, `"a/foo"` or `/dev/null`.
 */
function sidePathOf(raw: string, prefix: string): string | undefined {
    let value = raw.trim();
    if (value === '/dev/null') {
        return undefined;
    }
    if (value.startsWith('"') && value.endsWith('"')) {
        value = unescapeGitPath(value.slice(1, -1));
    }
    if (value.startsWith(prefix)) {
        value = value.slice(prefix.length);
    }
    return value || undefined;
}

/**
 * Undoes the C-style quoting git applies to a path with non-ASCII bytes, a
 * double quote or a backslash: `caf\303\251` is UTF-8 for `café`. Octal
 * escapes are byte values, so they are collected and decoded together rather
 * than one character at a time.
 */
function unescapeGitPath(raw: string): string {
    const bytes: number[] = [];

    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== '\\') {
            bytes.push(...Buffer.from(raw[i], 'utf8'));
            continue;
        }

        const next = raw[i + 1];
        const octal = raw.slice(i + 1, i + 4);

        if (/^[0-7]{3}$/.test(octal)) {
            bytes.push(parseInt(octal, 8));
            i += 3;
            continue;
        }

        const simple: Record<string, number> = {
            '"': 0x22,
            '\\': 0x5c,
            't': 0x09,
            'n': 0x0a,
            'r': 0x0d,
        };
        if (next !== undefined && next in simple) {
            bytes.push(simple[next]);
            i += 1;
            continue;
        }

        bytes.push(0x5c);
    }

    return Buffer.from(bytes).toString('utf8');
}
