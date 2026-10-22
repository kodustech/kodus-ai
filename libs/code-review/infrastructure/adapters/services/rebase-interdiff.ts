import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * #2037: after a rebase the last reviewed commit is no longer in the PR, so
 * there is no `compare(last...head)` to say what is new. This gives the same
 * answer from the PR diff before and after the rebase: a hunk of the current
 * diff is already reviewed when each of its changes (a run of `-`/`+` lines)
 * was in the previous diff of the same file. Line numbers and context lines
 * are not compared, because the rebase moves both.
 */
export interface RebaseInterdiffResult {
    /** What is left to review: changed files, each with only its new hunks. */
    files: FileChange[];
    /** Files whose every hunk was already reviewed. */
    unchangedFiles: string[];
    /** Files that kept some hunks and lost others. */
    partialFiles: string[];
    hunksKept: number;
    hunksDropped: number;
}

interface Hunk {
    text: string;
    changes: string[];
    additions: number;
    deletions: number;
}

const HUNK_HEADER = /^@@ /;

function splitHunks(patch: string): Hunk[] {
    const hunks: Hunk[] = [];
    let lines: string[] | null = null;
    const close = () => {
        if (lines) hunks.push(toHunk(lines));
    };
    for (const raw of patch.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (HUNK_HEADER.test(line)) {
            close();
            lines = [line];
        } else if (lines) {
            lines.push(line);
        }
    }
    close();
    return hunks;
}

function toHunk(lines: string[]): Hunk {
    const changes: string[] = [];
    let run: string[] = [];
    let additions = 0;
    let deletions = 0;
    const endRun = () => {
        if (run.length) changes.push(run.join('\n'));
        run = [];
    };
    for (const line of lines.slice(1)) {
        if (line.startsWith('+')) additions++;
        if (line.startsWith('-')) deletions++;
        if (line.startsWith('+') || line.startsWith('-')) run.push(line);
        else if (!line.startsWith('\\')) endRun();
    }
    endRun();
    // Trailing empty lines come from the patch's final newline, not the hunk.
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return { text: lines.join('\n'), changes, additions, deletions };
}

function countOf(hunks: Hunk[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const hunk of hunks) {
        for (const change of hunk.changes) {
            counts.set(change, (counts.get(change) ?? 0) + 1);
        }
    }
    return counts;
}

/** Takes the hunk's changes out of `available` only when all of them are there. */
function consume(hunk: Hunk, available: Map<string, number>): boolean {
    const needed = countOf([hunk]);
    for (const [change, n] of needed) {
        if ((available.get(change) ?? 0) < n) return false;
    }
    for (const [change, n] of needed) {
        available.set(change, available.get(change)! - n);
    }
    return true;
}

export function rebaseInterdiff(
    current: FileChange[],
    previous: FileChange[],
): RebaseInterdiffResult {
    const result: RebaseInterdiffResult = {
        files: [],
        unchangedFiles: [],
        partialFiles: [],
        hunksKept: 0,
        hunksDropped: 0,
    };
    const previousByName = new Map(previous.map((f) => [f.filename, f]));

    for (const file of current) {
        const before =
            previousByName.get(file.filename) ??
            (file.previous_filename
                ? previousByName.get(file.previous_filename)
                : undefined);
        const hunks = file.patch ? splitHunks(file.patch) : [];
        if (!before?.patch || !hunks.length) {
            result.files.push(file);
            continue;
        }

        const available = countOf(splitHunks(before.patch));
        const kept = hunks.filter((hunk) => !consume(hunk, available));
        result.hunksKept += kept.length;
        result.hunksDropped += hunks.length - kept.length;

        if (!kept.length) {
            result.unchangedFiles.push(file.filename);
        } else if (kept.length === hunks.length) {
            result.files.push(file);
        } else {
            const additions = kept.reduce((n, h) => n + h.additions, 0);
            const deletions = kept.reduce((n, h) => n + h.deletions, 0);
            result.partialFiles.push(file.filename);
            result.files.push({
                ...file,
                patch: kept.map((h) => h.text).join('\n'),
                additions,
                deletions,
                changes: additions + deletions,
            });
        }
    }
    return result;
}
