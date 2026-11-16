import { isIP } from 'net';

import { KODUS_EGRESS_DENY_PATTERNS, matchesEgressPattern } from '@libs/runtime/protocol/egress-catalog';

// Egress approvals (§4 proxy, §7): the org admin approves one domain for one
// environment, outside the recipe. The Kodus denylist wins over everything,
// including an approval, so an approval for a denied host is refused here.

/**
 * §4 "Allowlist padrão": generic storage, paste/share and request bins,
 * tunnels and LLM APIs; plus metadata and local names. One list with the
 * cell (libs/runtime/protocol/egress-lists.json, G2): the API refuses
 * approving a denied host and the cell refuses it from every source.
 */
export const DEFAULT_EGRESS_DENYLIST: readonly string[] = KODUS_EGRESS_DENY_PATTERNS;

export class InvalidEgressHostError extends Error {}

/** Lowercases, strips a trailing dot and refuses anything that is not a plain DNS name. */
export function normalizeEgressHost(raw: string): string {
    if (typeof raw !== 'string') throw new InvalidEgressHostError('host must be a string');
    const host = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253) throw new InvalidEgressHostError('host is empty or too long');
    if (isIP(host) || /^\[.*\]$/.test(host)) throw new InvalidEgressHostError('approve a domain, not an IP address');
    if (host.includes('*')) throw new InvalidEgressHostError('wildcards are not approved; name the exact domain');
    const labels = host.split('.');
    if (labels.length < 2) throw new InvalidEgressHostError('host must be a fully qualified domain');
    const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
    if (!labels.every((l) => label.test(l))) throw new InvalidEgressHostError('host is not a valid domain name');
    if (/^[0-9]+$/.test(labels[labels.length - 1])) throw new InvalidEgressHostError('host is not a valid domain name');
    return host;
}

/** The denylist entry that blocks `host`, or undefined. */
export function deniedBy(host: string, denylist: readonly string[]): string | undefined {
    return denylist.find((pattern) => matchesEgressPattern(host, pattern));
}

export function parseDenylist(env: string | undefined): string[] {
    return (env ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
