/** A changed file as the code hosts return it. */
export interface ChangedFile {
    filename: string;
    status?: string;
    patch?: string;
}

/** The PR's patches in one text, the way the judge reads them. Files without a patch are left out. */
export function formatPullRequestDiff(
    files: ChangedFile[] | undefined,
): string {
    return (files ?? [])
        .filter((file) => typeof file.patch === 'string' && file.patch.trim())
        .map(
            (file) =>
                `=== FILE: ${file.filename} ===\nStatus: ${file.status ?? 'modified'}\n\n${file.patch}`,
        )
        .join('\n\n');
}

/** About 50k tokens: room for the task, the instructions and the answer. */
export const DIFF_BUDGET_CHARS = 200_000;

const FILE_HEADER = /^(?:=== FILE: (.+?) ===|diff --git a\/\S+ b\/(\S+))$/gm;

/**
 * The diff the judge can read whole, and the files it had to leave out. Files
 * are kept in order; one that doesn't fit is skipped so smaller ones after it
 * still get in. A requirement that may live in a skipped file becomes CHECK
 * MANUALLY instead of MISSING (UC-32).
 */
export function fitDiff(
    diff: string,
    budget = DIFF_BUDGET_CHARS,
): { diff: string; unseenFiles: string[] } {
    if (diff.length <= budget) {
        return { diff, unseenFiles: [] };
    }
    const headers = [...diff.matchAll(FILE_HEADER)];
    if (!headers.length) {
        return {
            diff: diff.slice(0, budget),
            unseenFiles: ['(rest of the diff)'],
        };
    }
    const chunks = headers.map((header, i) => ({
        file: header[1] ?? header[2],
        text: diff.slice(
            header.index,
            i + 1 < headers.length ? headers[i + 1].index : diff.length,
        ),
    }));
    const kept: string[] = [];
    const unseenFiles: string[] = [];
    let used = 0;
    for (const chunk of chunks) {
        if (used + chunk.text.length <= budget) {
            kept.push(chunk.text);
            used += chunk.text.length;
        } else {
            unseenFiles.push(chunk.file);
        }
    }
    return { diff: kept.join(''), unseenFiles };
}
