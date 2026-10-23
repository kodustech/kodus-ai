import { diffArrays } from 'diff';

import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * #2037: after a rebase the last reviewed commit is no longer in the PR, so
 * there is no `compare(last...head)` to say what is new. This gives the same
 * answer from the PR diff before and after the rebase. A changed line (`-` or
 * `+`) of the current diff is already reviewed when the previous diff of the
 * same file has it in the same order (their longest common subsequence). Line
 * numbers and context lines are not compared, because the rebase moves both.
 *
 * What is left reads like a normal push: an already reviewed `+` line stays
 * as context, an already reviewed `-` line is left out, and a hunk with
 * nothing new is dropped.
 */
export interface RebaseInterdiffResult {
    /** What is left to review: changed files, each with only its new lines. */
    files: FileChange[];
    /** Files with nothing new. */
    unchangedFiles: string[];
    /** Files that kept some of their diff and lost the rest. */
    partialFiles: string[];
    /** Files too rewritten to compare within the bound; reviewed whole. */
    uncomparedFiles: string[];
    hunksKept: number;
    hunksDropped: number;
}

interface Hunk {
    header: string;
    lines: string[];
}

/** Past this many line edits, or this long, a file is reviewed whole: the
 *  comparison runs on the review worker, before ignore paths are applied. */
const MAX_EDIT_LENGTH = 1_000;
const COMPARE_TIMEOUT_MS = 200;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+(?:,\d+)?) @@(.*)$/;

const isChange = (line: string) => line.startsWith('+') || line.startsWith('-');

function splitHunks(patch: string): Hunk[] {
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;
    for (const raw of patch.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (HUNK_HEADER.test(line)) {
            current = { header: line, lines: [] };
            hunks.push(current);
        } else if (current) {
            current.lines.push(line);
        }
    }
    // Trailing empty lines come from the patch's final newline, not the hunk.
    for (const hunk of hunks) {
        while (hunk.lines.length && !hunk.lines.at(-1)) hunk.lines.pop();
    }
    return hunks;
}

const changesOf = (hunks: Hunk[]) =>
    hunks.flatMap((hunk) => hunk.lines.filter(isChange));

/** For each change line of `current`, in order: was it in `previous`?
 *  Null when the comparison would take more than the bound. */
function reviewedFlags(
    current: string[],
    previous: string[],
): boolean[] | null {
    const parts = diffArrays(previous, current, {
        maxEditLength: MAX_EDIT_LENGTH,
        timeout: COMPARE_TIMEOUT_MS,
    });
    if (!parts) return null;
    const flags: boolean[] = [];
    for (const part of parts) {
        if (part.removed) continue;
        for (let i = 0; i < part.value.length; i++) flags.push(!part.added);
    }
    return flags;
}

/** The hunk with reviewed lines turned to context (`+`) or left out (`-`);
 *  null when nothing in it is new. */
function narrow(hunk: Hunk, reviewed: () => boolean): Hunk | null {
    const lines: string[] = [];
    let anyNew = false;
    let narrowed = false;
    for (const line of hunk.lines) {
        if (!isChange(line)) {
            lines.push(line);
        } else if (!reviewed()) {
            anyNew = true;
            lines.push(line);
        } else {
            narrowed = true;
            if (line.startsWith('+')) lines.push(` ${line.slice(1)}`);
        }
    }
    if (!anyNew) return null;
    if (!narrowed) return hunk;

    const [, oldStart, newRange, rest] = hunk.header.match(HUNK_HEADER)!;
    const oldCount = lines.filter(
        (l) => !l.startsWith('+') && !l.startsWith('\\'),
    ).length;
    return {
        header: `@@ -${oldStart},${oldCount} +${newRange} @@${rest}`,
        lines,
    };
}

const render = (hunks: Hunk[]) =>
    hunks.map((h) => [h.header, ...h.lines].join('\n')).join('\n');

const count = (hunks: Hunk[], marker: '+' | '-') =>
    hunks.reduce(
        (n, h) => n + h.lines.filter((l) => l.startsWith(marker)).length,
        0,
    );

export function rebaseInterdiff(
    current: FileChange[],
    previous: FileChange[],
): RebaseInterdiffResult {
    const result: RebaseInterdiffResult = {
        files: [],
        unchangedFiles: [],
        partialFiles: [],
        uncomparedFiles: [],
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

        const flags = reviewedFlags(
            changesOf(hunks),
            changesOf(splitHunks(before.patch)),
        );
        if (!flags) {
            result.uncomparedFiles.push(file.filename);
            result.files.push(file);
            continue;
        }
        let next = 0;
        const reviewed = () => flags[next++];
        const kept = hunks
            .map((hunk) => narrow(hunk, reviewed))
            .filter((hunk): hunk is Hunk => !!hunk);
        result.hunksKept += kept.length;
        result.hunksDropped += hunks.length - kept.length;

        if (!kept.length) {
            result.unchangedFiles.push(file.filename);
        } else if (!flags.some(Boolean)) {
            result.files.push(file);
        } else {
            const additions = count(kept, '+');
            const deletions = count(kept, '-');
            result.partialFiles.push(file.filename);
            result.files.push({
                ...file,
                patch: render(kept),
                additions,
                deletions,
                changes: additions + deletions,
            });
        }
    }
    return result;
}
