import { diffArrays } from 'diff';

import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * #2037: after a rebase the last reviewed commit is no longer in the PR, so
 * there is no `compare(last...head)` to say what is new. This gives the same
 * answer from the PR diff before and after the rebase. A changed line (`-` or
 * `+`) of the current diff is already reviewed when the previous diff of the
 * same file has it in the same order (their longest common subsequence), in
 * the same place: the same scope and the same context lines around its run of
 * changes. Line numbers and the rest of the context are not compared, because
 * the rebase moves them.
 *
 * What is left reads like a normal push: an already reviewed `+` line stays
 * as context, an already reviewed `-` line is left out, and a hunk with
 * nothing new is dropped.
 *
 * #2319: a change line of the previous diff that the current diff no longer
 * carries cannot be represented here. It is either a revert (the push took an
 * added line away) or a change the base branch absorbed, and the two diffs
 * look the same. The result names those files in `revertedFiles` so the caller
 * can review the whole current PR instead of skipping the push.
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
    /** Files carrying a reviewed change the current diff no longer has. Their
     *  removals cannot be read from an interdiff, so the PR is reviewed whole. */
    revertedFiles: string[];
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

interface Scope {
    indent: number;
    text: string;
}

const indentOf = (content: string) =>
    content.length - content.trimStart().length;

/**
 * Tracks, for one side of a hunk (new: context and `+`; old: context and `-`),
 * the lines that open the scopes around the current line: each kept line is
 * less indented than the one after it.
 */
class ScopeStack {
    private readonly stack: Scope[] = [];

    constructor(private readonly outer: string) {}

    /** The scope enclosing `content`, which then becomes a candidate itself. */
    enter(content: string): string {
        if (!content.trim()) return this.top();
        const indent = indentOf(content);
        while (
            this.stack.length &&
            this.stack[this.stack.length - 1].indent >= indent
        ) {
            this.stack.pop();
        }
        const scope = this.top();
        this.stack.push({ indent, text: content.trim() });
        return scope;
    }

    private top(): string {
        return this.stack.length
            ? this.stack[this.stack.length - 1].text
            : this.outer;
    }
}

/** Each change line keyed on where it sits: the scope it is in (the nearest
 *  line of the hunk above it that is less indented, else the header's
 *  section, which Git takes from before the hunk), and, unless `withContext`
 *  is off, the context lines right above and below its run of changes. A
 *  change the rebase moved elsewhere in the file then does not read as
 *  reviewed. */
function changesOf(hunks: Hunk[], withContext = true): string[] {
    const changes: string[] = [];
    for (const hunk of hunks) {
        const { lines } = hunk;
        const section = hunk.header.match(HUNK_HEADER)?.[3]?.trim() ?? '';
        const added = new ScopeStack(section);
        const removed = new ScopeStack(section);
        let above = '';
        for (let i = 0; i < lines.length; i++) {
            if (!isChange(lines[i])) {
                if (lines[i].startsWith('\\')) continue;
                above = lines[i];
                added.enter(above.slice(1));
                removed.enter(above.slice(1));
                continue;
            }
            let end = i;
            while (
                end < lines.length &&
                (isChange(lines[end]) || lines[end].startsWith('\\'))
            ) {
                end++;
            }
            const below = lines[end] ?? '';
            for (let k = i; k < end; k++) {
                const line = lines[k];
                if (!isChange(line)) continue;
                const side = line.startsWith('+') ? added : removed;
                const scope = side.enter(line.slice(1));
                changes.push(
                    (withContext
                        ? [scope, above, below, line]
                        : [scope, line]
                    ).join('\u0000'),
                );
            }
            i = end - 1;
        }
    }
    return changes;
}

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

function countsOf(keys: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
}

/** How many change lines of `previous` the current diff lost. The scope is
 *  part of the identity, so a line dropped from one function while an
 *  identical line appears in another is a removal, and the interdiff cannot
 *  tell it from a move (#2319). The neighbouring context lines are left out on
 *  purpose: an edit there moves nothing, and counting it would send every
 *  touch of the lines around a change to a full review. */
function missingChangeLines(previous: Hunk[], current: Hunk[]): number {
    const now = countsOf(changesOf(current, false));
    let missing = 0;
    for (const [key, count] of countsOf(changesOf(previous, false))) {
        const left = now.get(key) ?? 0;
        if (left >= count) continue;
        missing += count - left;
    }
    return missing;
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
        revertedFiles: [],
        hunksKept: 0,
        hunksDropped: 0,
    };
    const previousByName = new Map(previous.map((f) => [f.filename, f]));
    const compared = new Set<string>();

    for (const file of current) {
        const before =
            previousByName.get(file.filename) ??
            (file.previous_filename
                ? previousByName.get(file.previous_filename)
                : undefined);
        if (before) compared.add(before.filename);
        const hunks = file.patch ? splitHunks(file.patch) : [];
        if (!before?.patch || !hunks.length) {
            result.files.push(file);
            continue;
        }

        const previousHunks = splitHunks(before.patch);
        // #2319: a reviewed change line the current diff no longer carries is
        // either reverted by the push or absorbed by the base branch, and the
        // two diffs look alike. An interdiff cannot show the removal, so the
        // caller has to review the whole current PR instead. This runs before
        // the bounded comparison, which can come back empty on a big file.
        if (missingChangeLines(previousHunks, hunks) > 0) {
            result.revertedFiles.push(file.filename);
        }
        const flags = reviewedFlags(changesOf(hunks), changesOf(previousHunks));
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

    // A file the current diff does not list at all: every change it carried is
    // gone from the PR. Same signal as above, and the same reason it cannot be
    // read as an interdiff (#2319).
    for (const before of previous) {
        if (compared.has(before.filename) || !before.patch) continue;
        if (!changesOf(splitHunks(before.patch)).length) continue;
        result.revertedFiles.push(before.filename);
    }

    return result;
}
