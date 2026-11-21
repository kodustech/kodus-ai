import { type ChangedFile, DIFF_TRUNCATED_MARKER_PATH, type EntryPoint } from './extract';

// Where a probe's entry point sits in the diff, for the Run page's link from a
// finding to the code: the changed file and the first line the patch adds
// there. Only a file of the diff is ever named, never a path the agent wrote
// that the PR does not change.

export interface DiffRef {
    file: string;
    /** The first added line of the file's patch, in the new file; absent when the patch adds none (a deletion). */
    line?: number;
}

/** The new-file line number of the first `+` line of a unified diff. */
export function firstAddedLine(patch: string | undefined): number | undefined {
    if (!patch) return undefined;
    let line: number | undefined;
    for (const row of patch.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
        if (hunk) {
            line = Number(hunk[1]);
            continue;
        }
        if (line === undefined) continue;
        if (row.startsWith('+') && !row.startsWith('+++')) return line;
        if (!row.startsWith('-') && !row.startsWith('\\')) line++;
    }
    return undefined;
}

/**
 * The diff file of an entry point: the probe's `via` (the changed file the
 * route reaches), else the file the extractor matched for that entry point id.
 */
export function diffRefOf(args: { entryPoint: string; via?: string; entryPoints: EntryPoint[]; files: ChangedFile[] }): DiffRef | undefined {
    const candidates = [args.via, args.entryPoints.find((e) => e.id === args.entryPoint)?.match.file];
    for (const file of candidates) {
        if (!file || file === DIFF_TRUNCATED_MARKER_PATH) continue;
        const changed = args.files.find((f) => f.path === file);
        if (!changed) continue;
        const line = firstAddedLine(changed.patch);
        return { file: file.slice(0, 1_024), ...(line !== undefined ? { line } : {}) };
    }
    return undefined;
}
