/**
 * How much of a blocker's message is kept: the cell's reason is at most 4096 bytes (CLAIM_FAILED_REASON_MAX), and a
 * failed build's step and its last lines are most of it, so 2000 characters keep what a developer needs to fix it.
 */
export const BLOCKER_MESSAGE_MAX = 2_000;

/**
 * A blocker's message: its start (the step and what ran) and its end (where a
 * build or compose says what failed), never only the start. The cell's reason
 * for a failed build is the docker command line first and the cause last.
 */
export function blockerMessage(text: string, max = BLOCKER_MESSAGE_MAX): string {
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    const sep = ' … ';
    const head = Math.floor(max * 0.3);
    const cause = causeLine(text);
    const headText = chars.slice(0, head).join('');
    // The tool's own error line (pnpm's ERR_PNPM_…, an `Error: …`) sits between the
    // command line and docker's generic "did not complete" tail: kept whole when
    // the start and the end would leave it out.
    if (cause && !headText.includes(cause)) {
        const causeChars = Array.from(cause).slice(0, Math.floor(max * 0.3));
        const tailLen = max - head - causeChars.length - 2 * sep.length;
        if (tailLen > 0 && !chars.slice(chars.length - tailLen).join('').includes(cause)) {
            return headText + sep + causeChars.join('') + sep + chars.slice(chars.length - tailLen).join('');
        }
    }
    return headText + sep + chars.slice(chars.length - (max - head - sep.length)).join('');
}

/** Docker's and the shell's generic failure lines: they say a step failed, not why. */
const GENERIC_FAILURE = /^(error|ERROR): (process "|failed to solve)|did not complete successfully/;

/** A download the build could not make: the network error code names the host on the same line (kr-n8n, kr-novu, kr-nocodb). */
const NETWORK_FAILURE = /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH)\b/;

/** The first line in a failure that names its cause: an error code (ERR_PNPM_…, E404), an `Error: …` line, or a network error. */
export function causeLine(text: string): string | undefined {
    for (const raw of text.split('\n')) {
        const line = raw.replace(/^#\d+\s+[\d.]+\s+/, '').trim();
        if (!line || GENERIC_FAILURE.test(line)) continue;
        if (/\bERR_[A-Z0-9_]{3,}\b/.test(line) || /^(npm ERR!|error|Error|ERROR|fatal|FATAL)[: !]/.test(line) || NETWORK_FAILURE.test(line)) return line;
    }
    return undefined;
}
