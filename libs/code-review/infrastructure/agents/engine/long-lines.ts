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
    let start = 0;
    const parts: string[] = [];
    while (start <= output.length) {
        const nl = output.indexOf('\n', start);
        const end = nl === -1 ? output.length : nl;
        const length = end - start;
        if (length > longest) longest = length;
        if (length > max) {
            cut++;
            parts.push(
                `${output.slice(start, start + max)} … [${length - max} more characters on this line not shown]`,
            );
        } else {
            parts.push(output.slice(start, end));
        }
        if (nl === -1) break;
        start = nl + 1;
    }
    return { text: cut ? parts.join('\n') : output, cut, longest };
}
