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
        const path = headerPaths(header).find((candidate) =>
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
 * The paths a `diff --git` header can name, best reading first.
 *
 * git writes `a/<old> b/<new>` and only quotes the header when a path holds a
 * non-ASCII byte, a quote or a backslash. A plain path that itself contains
 * " b/" therefore leaves more than one place to cut the header, and the
 * earliest cut shortens the path: `a/fixtures b/package-lock.json b/fixtures
 * b/package-lock.json`. The cut whose two sides agree is the path; the other
 * cuts stay available, in order, so a genuine rename still resolves.
 */
function headerPaths(header: string): string[] {
    const quoted = header.match(/^"a\/(.+?)" "b\/(.+)"$/);
    if (quoted) {
        const oldPath = unescapeGitPath(quoted[1]);
        const newPath = unescapeGitPath(quoted[2]);
        return oldPath === newPath ? [newPath] : [newPath, oldPath];
    }

    if (!header.startsWith('a/')) {
        return [];
    }

    const body = header.slice(2);
    const cuts: Array<{ oldPath: string; newPath: string }> = [];
    for (
        let at = body.indexOf(' b/');
        at !== -1;
        at = body.indexOf(' b/', at + 1)
    ) {
        cuts.push({
            oldPath: body.slice(0, at),
            newPath: body.slice(at + 3),
        });
    }

    const agreeing = cuts.filter((cut) => cut.oldPath === cut.newPath);
    const renamed = cuts.filter((cut) => cut.oldPath !== cut.newPath);

    return [...agreeing, ...renamed].map((cut) => cut.newPath);
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
