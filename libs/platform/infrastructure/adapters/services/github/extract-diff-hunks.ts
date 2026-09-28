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
        // `a/<path> b/<path>`. A path containing a space still parses, because
        // the b-side always starts at " b/" followed by the same path.
        const match = header.match(/^a\/(.+?) b\/(.+)$/);
        const path = match?.[2] ?? match?.[1];
        if (!path || !wanted.has(path)) {
            continue;
        }

        const firstHunk = section.indexOf('\n@@');
        if (firstHunk === -1) {
            // A rename or mode change with no content diff carries no hunks.
            continue;
        }

        out.push({ path, patch: section.slice(firstHunk + 1).trimEnd() });
    }

    return out;
}
