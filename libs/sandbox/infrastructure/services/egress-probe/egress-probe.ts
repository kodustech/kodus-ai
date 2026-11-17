/**
 * Pure pieces of the sandbox egress probe.
 *
 * Every review sandbox reaches the customer's Git host through the egress
 * proxy, so the traffic leaves from Kodus's fixed IP. Most organizations do
 * not need that: only those whose Git host (or GitHub org) allowlists our IP.
 * The probe answers "would this org's repository answer WITHOUT the proxy?"
 * by listing its branches from a sandbox that has no proxy. This module holds
 * the parts that need no sandbox: reading the result and keeping secrets out
 * of what is stored.
 */

export type EgressProbeOutcome = 'direct_ok' | 'direct_blocked';

export type EgressBlockReason =
    | 'ip_allow_list'
    | 'timeout'
    | 'network'
    | 'forbidden'
    | 'not_found'
    | 'auth'
    | 'other';

export interface EgressProbeVerdict {
    outcome: EgressProbeOutcome;
    reason?: EgressBlockReason;
}

/** Exit status `timeout(1)` uses when it stops the command. */
export const PROBE_TIMEOUT_EXIT_CODE = 124;

/** Seconds the direct listing may take before it counts as blocked. */
export const PROBE_LISTING_TIMEOUT_SECONDS = 30;

const MAX_DETAIL_LENGTH = 300;

/**
 * What a direct `git ls-remote` says about the org. The review's own clone,
 * through the proxy, already worked, so any failure here is the network path
 * that differs: our fixed IP. The reason is kept to tell the cases apart when
 * the list is reviewed, not to decide.
 */
export function classifyDirectProbe(
    exitCode: number,
    stderr: string,
): EgressProbeVerdict {
    if (exitCode === 0) return { outcome: 'direct_ok' };
    if (exitCode === PROBE_TIMEOUT_EXIT_CODE) {
        return { outcome: 'direct_blocked', reason: 'timeout' };
    }

    const text = stderr ?? '';
    let reason: EgressBlockReason = 'other';
    if (/ip allow ?list/i.test(text)) reason = 'ip_allow_list';
    else if (
        /(connection refused|connection timed out|failed to connect|could not connect|network is unreachable|operation timed out|connection reset)/i.test(
            text,
        )
    )
        reason = 'network';
    else if (/(error: 401|authentication failed)/i.test(text)) reason = 'auth';
    else if (/error: 403/i.test(text)) reason = 'forbidden';
    else if (/(error: 404|not found)/i.test(text)) reason = 'not_found';

    return { outcome: 'direct_blocked', reason };
}

/**
 * The part of git's error worth keeping: the lines that explain the failure,
 * with every secret the probe knows about and every credential embedded in a
 * URL removed, capped in size.
 */
export function sanitizeProbeDetail(
    stderr: string,
    secrets: readonly string[],
): string {
    let text = (stderr ?? '').replace(/\r/g, '');

    for (const secret of secrets) {
        if (!secret) continue;
        text = text.split(secret).join('[redacted]');
    }
    // Credentials in a URL (`scheme://user:secret@host`).
    text = text.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1[redacted]@');
    // Any Authorization header value that slipped through.
    text = text.replace(
        /(authorization:\s*\w+\s+)[A-Za-z0-9+/=._-]+/gi,
        '$1[redacted]',
    );

    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const relevant = lines.filter((l) => /^(remote:|fatal:|error:)/i.test(l));
    return (relevant.length ? relevant : lines)
        .join(' | ')
        .slice(0, MAX_DETAIL_LENGTH);
}

/** Lower-cased `host[:port]` of a clone URL, or null when it is not a URL. */
export function repositoryHost(cloneUrl: string): string | null {
    try {
        const host = new URL(cloneUrl).host.toLowerCase();
        return host || null;
    } catch {
        return null;
    }
}
