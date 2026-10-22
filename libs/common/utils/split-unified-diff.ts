export interface UnifiedDiffFile {
    filename: string;
    previous_filename?: string;
    status: 'added' | 'removed' | 'modified' | 'renamed';
    /** From the first `@@` on, the shape a host's per-file `patch` has. */
    patch: string;
    additions: number;
    deletions: number;
}

/** Splits a multi-file `git diff` into one entry per file. */
export function splitUnifiedDiff(diff: string): UnifiedDiffFile[] {
    if (!diff?.trim()) return [];

    return diff
        .split(/(?=^diff --git )/m)
        .map((section) => {
            const header = section.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
            if (!header) return null;

            const hunkStart = section.search(/^@@ /m);
            const head = hunkStart === -1 ? section : section.slice(0, hunkStart);
            const patch =
                hunkStart === -1 ? '' : section.slice(hunkStart).trimEnd();
            const renamedFrom = head.match(/^rename from (.+)$/m)?.[1];

            let additions = 0;
            let deletions = 0;
            for (const line of patch.split('\n')) {
                if (line.startsWith('+')) additions++;
                else if (line.startsWith('-')) deletions++;
            }

            const file: UnifiedDiffFile = {
                filename: header[2],
                status: /^new file mode/m.test(head)
                    ? 'added'
                    : /^deleted file mode/m.test(head)
                      ? 'removed'
                      : renamedFrom
                        ? 'renamed'
                        : 'modified',
                patch,
                additions,
                deletions,
            };
            if (renamedFrom) file.previous_filename = renamedFrom;
            return file;
        })
        .filter((file): file is UnifiedDiffFile => !!file);
}
