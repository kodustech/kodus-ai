import { isIP } from 'net';

// Egress approvals (§4 proxy, §7): the org admin approves one domain for one
// environment, outside the recipe. The Kodus denylist wins over everything,
// including an approval, so an approval for a denied host is refused here.

/**
 * §4 "Allowlist padrão": generic storage, paste/share and request bins,
 * tunnels and LLM APIs; plus metadata and local names. A guardrail on what an
 * admin may approve, not a perimeter: the cell proxy denies by default.
 */
export const DEFAULT_EGRESS_DENYLIST: readonly string[] = [
    // generic storage (the cell's own bucket is reached through the VPC endpoint, never by approval)
    '*.s3.amazonaws.com',
    's3.amazonaws.com',
    's3.*.amazonaws.com',
    '*.s3.*.amazonaws.com',
    'storage.googleapis.com',
    '*.blob.core.windows.net',
    // paste and file sharing
    'pastebin.com',
    '*.pastebin.com',
    'transfer.sh',
    '*.transfer.sh',
    'file.io',
    '*.file.io',
    'webhook.site',
    '*.webhook.site',
    'requestbin.com',
    '*.requestbin.com',
    '*.pipedream.net',
    'raw.githubusercontent.com',
    'gist.githubusercontent.com',
    'gist.github.com',
    '*.r2.dev',
    '*.workers.dev',
    'discord.com',
    '*.discord.com',
    // tunnels
    'ngrok.io',
    '*.ngrok.io',
    '*.ngrok.app',
    '*.ngrok.dev',
    '*.ngrok-free.app',
    '*.ngrok-free.dev',
    '*.trycloudflare.com',
    '*.loca.lt',
    '*.localtunnel.me',
    'serveo.net',
    '*.serveo.net',
    // LLM APIs (the agent goes through the product gateway, the app under test never does)
    'api.openai.com',
    '*.openai.azure.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'openrouter.ai',
    'api.groq.com',
    'api.mistral.ai',
    'api.deepseek.com',
    'api.together.xyz',
    'api.fireworks.ai',
    'bedrock-runtime.*.amazonaws.com',
    // metadata and local names
    'metadata.google.internal',
    'metadata',
    'localhost',
    '*.localhost',
    '*.internal',
    '*.local',
];

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

/** `*` stands for one or more labels; everything else matches literally. */
function matches(host: string, pattern: string): boolean {
    const p = pattern.trim().toLowerCase().replace(/\.$/, '');
    if (!p) return false;
    const source = p
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[a-z0-9-]+(?:\\.[a-z0-9-]+)*');
    return new RegExp(`^${source}$`).test(host);
}

/** The denylist entry that blocks `host`, or undefined. */
export function deniedBy(host: string, denylist: readonly string[]): string | undefined {
    return denylist.find((pattern) => matches(host, pattern));
}

export function parseDenylist(env: string | undefined): string[] {
    return (env ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
