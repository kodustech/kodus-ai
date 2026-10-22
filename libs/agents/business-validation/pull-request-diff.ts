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
    const chunks = fileChunks(diff);
    if (!chunks.length) {
        return {
            diff: diff.slice(0, budget),
            unseenFiles: ['(rest of the diff)'],
        };
    }
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

/** One file's part of the diff, header included. */
function fileChunks(diff: string): Array<{ file: string; text: string }> {
    const headers = [...diff.matchAll(FILE_HEADER)];
    return headers.map((header, i) => ({
        file: header[1] ?? header[2],
        text: diff.slice(
            header.index,
            i + 1 < headers.length ? headers[i + 1].index : diff.length,
        ),
    }));
}

/**
 * About 6k tokens: what one second look at a requirement re-reads on every
 * step. The agent reads any other file with `read_file`.
 */
export const GAP_DIFF_CHARS = 24_000;

/**
 * The diff for a second look at one requirement: whole when it is small;
 * otherwise the files its evidence cites first, then others while they fit,
 * and the names of the rest for `read_file`. Sent on every step of up to
 * eight checks, the whole diff of a large PR cost millions of tokens a run.
 */
export function diffFor(
    diff: string,
    files: string[],
    budget = GAP_DIFF_CHARS,
): string {
    if (diff.length <= budget) {
        return diff;
    }
    const chunks = fileChunks(diff);
    if (!chunks.length) {
        return `${diff.slice(0, budget)}\n… (cut)`;
    }
    const cited = new Set(files);
    const ordered = [
        ...chunks.filter((c) => cited.has(c.file)),
        ...chunks.filter((c) => !cited.has(c.file)),
    ];
    const kept: string[] = [];
    const left: string[] = [];
    const room = Math.min(OMITTED_FILES_CHARS, Math.floor(budget / 10));
    let used = room;
    for (const chunk of ordered) {
        if (used + chunk.text.length <= budget) {
            kept.push(chunk.text);
            used += chunk.text.length;
        } else {
            left.push(chunk.file);
        }
    }
    return left.length
        ? `${kept.join('')}${omittedFiles(left, room)}`
        : kept.join('');
}

/** Most room kept for the names of the files left out, so the whole stays in budget. */
const OMITTED_FILES_CHARS = 2_000;

/** The files left out, by name, cut to the room kept for them. */
function omittedFiles(files: string[], room: number): string {
    const head =
        '\n\nAlso changed, not shown here (read them with read_file): ';
    let list = '';
    for (const [i, file] of files.entries()) {
        const more = `, … and ${files.length - i} more`;
        const next = `${list ? ', ' : ''}${file}`;
        if (head.length + list.length + next.length + more.length > room) {
            return `${head}${list}${more}`;
        }
        list += next;
    }
    return `${head}${list}`;
}
