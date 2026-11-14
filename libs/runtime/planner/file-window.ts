import { redactPatterns } from '@libs/runtime/redaction';

import { isSecretFile, modelView } from './repo-reader';

// read_file of the test planner (ADR-069) answers with a window of numbered
// lines, not the whole file: every step re-sends the conversation, so a 64 KB
// read paid once is paid again on every step after it. The planner reads the
// lines it was pointed at (a search hit, a changed hunk) and asks for more by
// range.

export const WINDOW_LIMITS = {
    /** A file this short is shown whole. */
    wholeLines: 160,
    /** Lines one read shows at most. */
    maxLines: 220,
    /** Lines around each line the read was pointed at (a search hit, a changed line). */
    around: 25,
    /** Characters of one line shown; a longer one (minified code) is cut. */
    lineChars: 300,
    /** Bytes of a file a read loads to window it (the search reads as much). */
    fileBytes: 256 * 1024,
} as const;

export type Range = [number, number];

/** Sorted, merged ranges. */
export function mergeRanges(ranges: Range[]): Range[] {
    const sorted = ranges.filter(([s, e]) => e >= s).sort((a, b) => a[0] - b[0]);
    const out: Range[] = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else out.push([r[0], r[1]]);
    }
    return out;
}

const covered = (shown: Range[], [s, e]: Range) => shown.some(([a, b]) => a <= s && e <= b);

/** The ranges a read shows: the one asked for, or around the lines it was pointed at, or the top. */
export function windowsOf(total: number, ask: { startLine?: number; endLine?: number }, focus: number[]): Range[] {
    const clamp = (n: number) => Math.min(Math.max(1, Math.floor(n)), Math.max(total, 1));
    if (ask.startLine !== undefined || ask.endLine !== undefined) {
        const s = clamp(ask.startLine ?? (ask.endLine ?? 1) - WINDOW_LIMITS.maxLines + 1);
        const e = clamp(Math.min(ask.endLine ?? s + WINDOW_LIMITS.wholeLines - 1, s + WINDOW_LIMITS.maxLines - 1));
        return [[s, Math.max(s, e)]];
    }
    if (total <= WINDOW_LIMITS.wholeLines) return [[1, Math.max(total, 1)]];
    const around = mergeRanges(focus.filter((l) => l >= 1 && l <= total).map((l) => [clamp(l - WINDOW_LIMITS.around), clamp(l + WINDOW_LIMITS.around)]));
    const out: Range[] = [];
    let left: number = WINDOW_LIMITS.maxLines;
    for (const [s, e] of around) {
        if (left <= 0) break;
        const end = Math.min(e, s + left - 1);
        out.push([s, end]);
        left -= end - s + 1;
    }
    return out.length ? out : [[1, WINDOW_LIMITS.wholeLines]];
}

export interface WindowedRead {
    output: string;
    /** What was shown; empty when nothing new was. */
    shown: Range[];
}

/**
 * The model's view of one file: secret files as modelView shows them (names
 * only), every other file redacted whole first (a pattern cut by a window edge
 * would slip through) and then windowed. Ranges already shown in this round
 * (`seen`) are named instead of being sent again.
 */
export function windowedView(
    path: string,
    text: string,
    ask: { startLine?: number; endLine?: number },
    focus: number[],
    seen: Range[],
): WindowedRead {
    if (isSecretFile(path)) return { output: modelView(path, text), shown: [] };
    const lines = redactPatterns(text).text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const windows = windowsOf(total, ask, focus);
    if (windows.every((w) => covered(seen, w))) {
        return { output: `[${path} lines ${windows.map(([s, e]) => `${s}-${e}`).join(', ')} were already shown in this round; read other lines, or submit]`, shown: [] };
    }
    const body = windows
        .map(([s, e]) =>
            lines
                .slice(s - 1, e)
                .map((l, i) => `${s + i}: ${l.length > WINDOW_LIMITS.lineChars ? `${l.slice(0, WINDOW_LIMITS.lineChars)}…` : l}`)
                .join('\n'),
        )
        .join('\n…\n');
    const whole = windows.length === 1 && windows[0][0] === 1 && windows[0][1] >= total;
    const head = whole ? `${path} (${total} lines)` : `${path}: lines ${windows.map(([s, e]) => `${s}-${e}`).join(', ')} of ${total}`;
    const tail = whole ? '' : '\n[more lines: read_file with startLine and endLine]';
    return { output: `${head}\n${body}${tail}`, shown: windows };
}

/** Each changed file's patch rows (the run's diff is `--- <path>` followed by that file's unified patch). */
export function filePatches(diff: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    let cur: string[] | undefined;
    const rows = diff.split('\n');
    for (const [i, row] of rows.entries()) {
        const file = /^--- (\S.*)$/.exec(row);
        if (file && (rows[i + 1] ?? '').startsWith('@@')) {
            cur = [];
            out.set(file[1].replace(/^a\//, ''), cur);
            continue;
        }
        cur?.push(row);
    }
    return out;
}

/** Lines of each changed file the diff touches, on each side: the head's for added lines, the base's for removed ones. */
export function changedLinesByFile(diff: string): Map<string, { base: number[]; head: number[] }> {
    const out = new Map<string, { base: number[]; head: number[] }>();
    for (const [path, rows] of filePatches(diff)) {
        const cur = { base: [] as number[], head: [] as number[] };
        let oldLine = 0;
        let newLine = 0;
        for (const row of rows) {
            const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
            if (hunk) {
                oldLine = Number(hunk[1]);
                newLine = Number(hunk[2]);
            } else if (row.startsWith('+')) {
                cur.head.push(newLine++);
                cur.base.push(oldLine);
            } else if (row.startsWith('-')) {
                cur.base.push(oldLine++);
                cur.head.push(newLine);
            } else if (!row.startsWith('\\')) {
                oldLine++;
                newLine++;
            }
        }
        out.set(path, cur);
    }
    return out;
}
