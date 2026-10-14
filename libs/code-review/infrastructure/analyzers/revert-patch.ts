/**
 * Reconstructs the pre-change version of a file from its current content and
 * the patch that produced it.
 *
 * Sandboxes are cloned `--depth=1`, so the base commit is not present and
 * `git show <base>:<path>` is not available. The patch is therefore the only
 * record of the previous version we have. That is enough: a unified diff names
 * exactly which line ranges changed, so every region it does not mention is
 * byte-identical in both versions and can be carried across untouched.
 *
 * Returns null rather than a best guess whenever the patch does not line up
 * with the file, so a stale or corrupt diff cannot produce a wrong "before"
 * file.
 */
export function revertPatch(
    head: string,
    patch: string | undefined,
): string | null {
    if (!patch) {
        return null;
    }

    const headLines = head.split('\n');
    const out: string[] = [];

    /** 1-based position in `headLines`. */
    let cursor = 1;
    let sawHunk = false;

    for (const raw of patch.split('\n')) {
        const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);

        if (header) {
            const start = parseInt(header[1], 10);
            const count = header[2] === undefined ? 1 : parseInt(header[2], 10);

            // A zero-length new side names the line the hunk follows rather
            // than a range, so the copy runs one line further.
            const target = count === 0 ? start + 1 : start;
            if (target < cursor || target > headLines.length + 1) {
                return null;
            }

            while (cursor < target) {
                out.push(headLines[cursor - 1]);
                cursor++;
            }

            sawHunk = true;
            continue;
        }

        if (!sawHunk || raw.startsWith('\\')) {
            continue;
        }

        const text = raw.slice(1);

        if (raw.startsWith('-')) {
            // Old side only: restored here, and absent from `headLines`.
            out.push(text);
            continue;
        }

        if (raw.startsWith('+') || raw.startsWith(' ') || raw === '') {
            const expected = raw === '' ? '' : text;
            if (
                cursor > headLines.length ||
                headLines[cursor - 1] !== expected
            ) {
                return null;
            }
            if (!raw.startsWith('+')) {
                out.push(expected);
            }
            cursor++;
            continue;
        }

        return null;
    }

    if (!sawHunk) {
        return null;
    }

    while (cursor <= headLines.length) {
        out.push(headLines[cursor - 1]);
        cursor++;
    }

    return out.join('\n');
}
