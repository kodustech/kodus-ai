import { createHash } from 'crypto';

/**
 * Names the credential in a set of auth headers without carrying it: the
 * first 16 hex characters of a SHA-256 over the headers, names lowercased and
 * sorted. The worker sends it when an MCP server refuses a credential; the
 * MCP Manager computes it over what it holds, so a refusal of an older
 * credential (refreshed or reconnected since) is told apart from a refusal of
 * the current one.
 *
 * Returns undefined when there are no headers: nothing was sent, so nothing
 * was refused.
 */
export function credentialFingerprint(
    headers: Record<string, string> | undefined,
): string | undefined {
    const entries = Object.entries(headers ?? {})
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (!entries.length) return undefined;
    return createHash('sha256')
        .update(JSON.stringify(entries))
        .digest('hex')
        .slice(0, 16);
}
