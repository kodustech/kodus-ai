/**
 * Longest line a search tool (grep, getCallers) hands to the agent.
 *
 * A match inside a minified bundle, a lockfile or a one-line JSON is a single
 * line of hundreds of KB. The agent cannot use it, and every later step pays
 * for it: the context compressor tokenizes the whole history on each step,
 * and tiktoken is quadratic on a long run without separators (an 88s stall in
 * prod, 2026-11-19). Code lines are far shorter than this, so a normal match
 * is never touched.
 */
export const MAX_TOOL_LINE_CHARS = 2_000;

export interface CutLongLines {
    text: string;
    /** Lines that were cut. */
    cut: number;
    /** Length of the longest line before the cut. */
    longest: number;
    /**
     * The files the cut lines came from (rg prints `path:line:` or
     * `path-line-` first), at most MAX_CUT_FILES: what to look at.
     */
    files: string[];
}

const MAX_CUT_FILES = 5;

/**
 * The path rg printed before the line number, if the line has one: `path:N:`
 * on a match line, `path-N-` on a context line. Boundaries are read in order:
 * the first `:N:`, or an earlier `-N-` that follows a file name with an
 * extension, wins (a `-N-` inside a path such as `2024-11-19-add.sql` is
 * skipped; a `:N:` in a context line's text such as `10:30:00` is never
 * reached). With neither, the first `-N-`.
 */
function pathOf(line: string): string | undefined {
    const head = line.slice(0, 600);
    const boundary = /:\d+:|-\d+-/g;
    let firstDash: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = boundary.exec(head)) && m.index <= 500) {
        boundary.lastIndex = m.index + 1;
        if (m.index === 0) continue;
        const prefix = head.slice(0, m.index);
        if (m[0][0] === ':') return prefix;
        firstDash ??= prefix;
        const base = prefix.slice(prefix.lastIndexOf('/') + 1);
        if (base.includes('.')) return prefix;
    }
    return firstDash;
}

/**
 * Cuts every line longer than `max` to its first `max` characters and says
 * how much was dropped. Linear in the output: one pass, no regex.
 */
export function cutLongLines(
    output: string,
    max: number = MAX_TOOL_LINE_CHARS,
): CutLongLines {
    let cut = 0;
    let longest = 0;
    const files: string[] = [];
    let start = 0;
    const parts: string[] = [];
    while (start <= output.length) {
        const nl = output.indexOf('\n', start);
        const end = nl === -1 ? output.length : nl;
        const length = end - start;
        if (length > longest) longest = length;
        if (length > max) {
            cut++;
            // Never end on the first half of a surrogate pair: a lone
            // surrogate makes the request body ill-formed for the provider.
            let keep = max;
            const last = output.charCodeAt(start + keep - 1);
            if (last >= 0xd800 && last <= 0xdbff) keep--;
            const file = pathOf(output.slice(start, start + keep));
            if (file && files.length < MAX_CUT_FILES && !files.includes(file))
                files.push(file);
            parts.push(
                `${output.slice(start, start + keep)} … [${length - keep} more characters on this line not shown]`,
            );
        } else {
            parts.push(output.slice(start, end));
        }
        if (nl === -1) break;
        start = nl + 1;
    }
    return { text: cut ? parts.join('\n') : output, cut, longest, files };
}
