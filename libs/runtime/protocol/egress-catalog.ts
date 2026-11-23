import LISTS from './egress-lists.json';

// The Kodus egress lists (docs/runtime/egress-allowlist.md §7): the deny list
// the API and the cell both enforce, and the recommended list the cell applies
// to every claim of an org that keeps it on. egress-lists.json is the one
// source; apps/runtime-cell/internal/netguard/egress-lists.json is its byte copy.

/** How the cell reaches a recommended host: through its read-only mirror, or through the inspected tier (TLS ends at the cell, GET/HEAD only, under the entry's paths). */
export type EgressTier = 'mirror' | 'inspected';

export interface RecommendedEgressEntry {
    host: string;
    ecosystem: string;
    tier: EgressTier;
    /** Path prefixes a request may name; `*` is one path segment. */
    paths: string[];
    /** Prefixes refused even under `paths` (npm's `/-/` account and token routes). */
    exceptPaths?: string[];
    /** refuse: never reached over TLS from a machine that does not trust the cell CA (the builder): the host takes writes. */
    untrusted?: 'refuse';
    /** passthrough: a read-only CDN an image build reaches uninspected; any other host is refused to a build. */
    build?: 'passthrough';
    why: string;
    doc: string;
    /** The recommended version that added it. */
    since: number;
}

/** The build args the cell passes every image build with its mirror, by ecosystem (§16). */
export interface MirrorBuildArgs {
    npm: string[];
    pypi: string[];
    go: string[];
    /** Tools that download a known build artifact and honor a mirror variable (§17). */
    artifacts: string[];
}

interface EgressListsFile {
    deny: { patterns: string[]; cases: { denied: string[]; allowed: string[] } };
    mirrorBuildArgs: MirrorBuildArgs & { about: string };
    recommended: { version: number; entries: RecommendedEgressEntry[] };
}

const lists = LISTS as EgressListsFile;

/** Every pattern of the Kodus deny list. */
export const KODUS_EGRESS_DENY_PATTERNS: readonly string[] = Object.freeze([...lists.deny.patterns]);

/** The hosts the shared file says each side must deny and must not, for the parity tests. */
export const KODUS_EGRESS_DENY_CASES = lists.deny.cases;

export const MIRROR_BUILD_ARGS: Readonly<MirrorBuildArgs> = Object.freeze({
    npm: [...lists.mirrorBuildArgs.npm],
    pypi: [...lists.mirrorBuildArgs.pypi],
    go: [...lists.mirrorBuildArgs.go],
    artifacts: [...lists.mirrorBuildArgs.artifacts],
});

export const RECOMMENDED_EGRESS_VERSION: number = lists.recommended.version;

export const RECOMMENDED_EGRESS: readonly RecommendedEgressEntry[] = Object.freeze(lists.recommended.entries.map((e) => Object.freeze({ ...e })));

const LABEL_CHARS = '[a-z0-9_-]';

/**
 * Whether the normalized host matches the pattern. `*` stands for one or more
 * host characters, dots included: `*.ngrok.io` is every name under ngrok.io,
 * `s3-*.amazonaws.com` every s3-<region> spelling (the cell's
 * netguard.MatchesPattern compiles the same expression).
 */
export function matchesEgressPattern(host: string, pattern: string): boolean {
    const p = pattern.trim().toLowerCase().replace(/\.$/, '');
    if (!p) return false;
    const source = p
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join(`${LABEL_CHARS}+(?:\\.${LABEL_CHARS}+)*`);
    return new RegExp(`^${source}$`).test(host);
}
