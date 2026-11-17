import { DIFF_TRUNCATED_MARKER_PATH } from './extract';
import { type ChangedSource, codeShapeOf, isDocumentation, parsedLanguage, patchRowsOf } from './no-effect';

// The changed lines the cell measures with the PR side's line coverage: per
// changed JS/TS file, the new-side line numbers of added rows that hold code.
// Removed rows are left out (they no longer exist to run), and so are
// comments, blank lines, tests and documentation. Pure: read by parsers only.

/** At most this many files go to the cell; the rest of the diff is not measured. */
export const MAX_EXERCISED_FILES = 100;
/** At most this many lines of one file go to the cell. */
export const MAX_EXERCISED_LINES_PER_FILE = 5_000;

const TEST_FILE = [/\.(spec|test)\.[cm]?[jt]sx?$/, /(^|\/)__tests__\//];
const COMMENT_OR_BLANK = /^\s*($|\/\/|\/\*|\*)/;

export interface ExecutableChangedFile {
    path: string;
    /** 1-based new-side line numbers, ascending. */
    lines: number[];
}

const isMeasurable = (path: string) =>
    parsedLanguage(path) === 'js' && path !== DIFF_TRUNCATED_MARKER_PATH && !isDocumentation(path) && !TEST_FILE.some((t) => t.test(path));

function addedCodeLines(file: ChangedSource): number[] {
    const rows = file.patch ? patchRowsOf(file.patch) : undefined;
    if (!rows) return [];
    const addedRows = rows.filter((r) => r.kind === '+');
    const shape = file.content !== undefined ? codeShapeOf(file.path, file.content) : undefined;
    // Without a parsed head, a row counts unless it is blank or starts a comment.
    const kept = shape ? addedRows.filter((r) => shape.codeLines.has(r.headLine)) : addedRows.filter((r) => !COMMENT_OR_BLANK.test(r.text));
    return [...new Set(kept.map((r) => r.headLine))].sort((a, b) => a - b);
}

/** Per changed JS/TS file of the diff, the new-side lines of changed executable code; files with none are left out. */
export function executableChangedLines(
    files: ChangedSource[],
    opts: { maxFiles?: number; maxLinesPerFile?: number } = {},
): ExecutableChangedFile[] {
    const maxFiles = opts.maxFiles ?? MAX_EXERCISED_FILES;
    const maxLines = opts.maxLinesPerFile ?? MAX_EXERCISED_LINES_PER_FILE;
    const out: ExecutableChangedFile[] = [];
    for (const file of files) {
        if (out.length >= maxFiles) break;
        if (!isMeasurable(file.path)) continue;
        const lines = addedCodeLines(file);
        if (lines.length) out.push({ path: file.path, lines: lines.slice(0, maxLines) });
    }
    return out;
}
