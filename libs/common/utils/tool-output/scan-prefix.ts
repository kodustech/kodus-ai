/**
 * Most characters of a tool answer the output guards read.
 *
 * The secret-file filter and the long-line cut are synchronous and linear in
 * what they read, so they run on the worker's main thread for as long as the
 * answer is long. Tools keep a few kilobytes at most (40 grep groups, 64k for
 * the conversation agent), yet the guards used to read the WHOLE answer first:
 * an `exec` printing a `git log -p` held a worker for 126s on 424 MB, long
 * enough for the ECS health check to give up on it (Nov 2026). A prefix this
 * size still fills every tool's answer after secret and long lines leave.
 */
export const MAX_TOOL_SCAN_CHARS = 1_000_000;

export interface ScannedPrefix {
    /** The head the guards read: whole lines, at most `max` characters. */
    text: string;
    /** Characters of the answer the guards never read (0: all of it). */
    unread: number;
}

/**
 * `text` cut to at most `max` UTF-16 units, one unit shorter when the cut
 * would leave the high half of a surrogate pair (an emoji) dangling.
 */
export function cutAt(text: string, max: number): string {
    if (text.length <= max) return text;
    const code = text.charCodeAt(max - 1);
    const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
    return text.slice(0, end);
}

export function scanPrefix(
    value: string,
    max: number = MAX_TOOL_SCAN_CHARS,
): ScannedPrefix {
    if (value.length <= max) return { text: value, unread: 0 };
    const head = cutAt(value, max);
    const lastLine = head.lastIndexOf('\n');
    // One line longer than the cap: the long-line cut shortens it anyway.
    const text = lastLine > 0 ? head.slice(0, lastLine) : head;
    return { text, unread: value.length - text.length };
}
