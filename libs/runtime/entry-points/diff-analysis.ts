import { DIFF_TRUNCATED_MARKER_PATH, type ChangedFile, type EntryPoint, entryPointsOfFile, mergeEntryPoints } from './extract';
import { type ExecutableChangedFile, executableLinesOfFile, MAX_EXERCISED_FILES, MAX_EXERCISED_LINES_PER_FILE } from './executable-lines';
import { type ChangedSource, forgetFile, isDocumentation, judgedBaseOf, newParseMemo, noRuntimeEffectOfFile, type ParseMemo, warmShape, withParseMemo } from './no-effect';

// Everything a Run reads from its diff with a parser, in one pass
// (p1-performance P12): whether it changes nothing that runs, its entry
// points and the changed executable lines the cell measures. Each side of
// each file is parsed and walked once (no-effect.ts ParseMemo), and the event
// loop is given back before every parse, every few thousand nodes of a walk
// and between files, so a large diff never holds the runtime-worker's only
// thread for long. The text parsed is bounded per Run; a file past it reads
// as one that does not parse, which every reader takes the conservative way
// (its changed rows are code, it reaches every route of its file).

/**
 * The most text one analysis parses, both sides together, in characters:
 * about 1 s of parsing in slices of a few ms. A diff the product sends is at
 * most 40 files of 256 KiB each (code-management-git.adapter.ts).
 */
export const DIFF_PARSE_BUDGET_CHARS = 4 * 1024 * 1024;

export interface DiffAnalysis {
    /** noRuntimeEffectOf: each file and why it changes nothing that runs, when every file does. */
    noRuntimeEffect?: { file: string; why: string }[];
    /** extractEntryPoints, every kind (dependency surface included). */
    entryPoints: EntryPoint[];
    /** executableChangedLines with the caller's bounds. */
    executable: ExecutableChangedFile[];
    /** Text parsed, in characters, and the files left unparsed because the budget was spent. */
    parsedChars: number;
    overBudget: string[];
}

export interface DiffAnalysisOptions {
    recipe?: Iterable<string>;
    truncated?: boolean;
    maxExercisedFiles?: number;
    maxExercisedLinesPerFile?: number;
    budgetChars?: number;
    /** Gives the event loop back; a setImmediate turn by default. */
    pause?: () => Promise<void>;
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The same answers as noRuntimeEffectOf, extractEntryPoints and
 * executableChangedLines over these files, parsed once and given back to the
 * event loop as it goes.
 */
export async function analyzeDiff(files: Array<ChangedFile & ChangedSource>, opts: DiffAnalysisOptions = {}): Promise<DiffAnalysis> {
    const pause = opts.pause ?? nextTurn;
    const memo: ParseMemo = newParseMemo(opts.budgetChars ?? DIFF_PARSE_BUDGET_CHARS);
    const recipe = new Set(opts.recipe ?? []);
    const perFile: EntryPoint[][] = [];
    const noEffect: Array<{ file: string; why: string } | undefined> = [];
    const executable: ExecutableChangedFile[] = [];
    const maxFiles = opts.maxExercisedFiles ?? MAX_EXERCISED_FILES;
    const maxLines = opts.maxExercisedLinesPerFile ?? MAX_EXERCISED_LINES_PER_FILE;
    for (const f of files) {
        // Each side the readers would parse, base then head, parsed and walked into the memo: the budget goes to the first files.
        if (f.path !== DIFF_TRUNCATED_MARKER_PATH && !recipe.has(f.path) && !isDocumentation(f.path)) {
            const base = judgedBaseOf(f);
            if (base !== undefined) await warmShape(memo, f.path, base, pause);
            if (f.content !== undefined) await warmShape(memo, f.path, f.content, pause);
        }
        await pause();
        // The readers of this file, from the memo: no parse is left, only what each reads of the tree.
        withParseMemo(memo, () => {
            perFile.push(entryPointsOfFile(f, recipe));
            noEffect.push(noRuntimeEffectOfFile(f, recipe));
            if (executable.length < maxFiles) {
                const lines = executableLinesOfFile(f, maxLines);
                if (lines) executable.push(lines);
            }
        });
        // Every reader reads only its own file: its trees are dropped before the next file's are made.
        forgetFile(memo, f.path);
    }
    const unchanged = !opts.truncated && files.length > 0 && noEffect.every((n) => n !== undefined) ? (noEffect as { file: string; why: string }[]) : undefined;
    return {
        ...(unchanged ? { noRuntimeEffect: unchanged } : {}),
        entryPoints: mergeEntryPoints(files, perFile),
        executable,
        parsedChars: memo.parsedChars,
        overBudget: [...memo.overBudget],
    };
}
