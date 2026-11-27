import { createHash } from 'crypto';

import { z } from 'zod';

// The shared image store (docs/runtime/shared-image-store.md). One port, chosen by the pool's config: the hub asks
// a provider for a short-lived credential scoped to named repositories, and the cell moves OCI blobs with it. What
// differs between providers is where the endpoint is and how the credential is minted; the wire is the OCI
// distribution API. The customer never sees which provider it is.

/** Closed set of providers; a new one is a new member and an adapter that passes `describeImageStoreConformance`. */
export const IMAGE_STORE_PROVIDERS = ['oci-registry', 'fake'] as const;
export type ImageStoreProviderKind = (typeof IMAGE_STORE_PROVIDERS)[number];

const RepoSegment = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const Prefix = z.string().min(1).max(128).refine((p) => p.split('/').every((s) => RepoSegment.test(s)), 'a repository prefix: lower-case segments joined by /');

/**
 * The pool's `imageStore` block (docs/runtime/shared-image-store.md section 3). Absent: the pool has no store and its
 * claims build as before. It never enters `poolSpecHash`: changing it moves where images go, not what a host is.
 */
export const ImageStoreConfigSchema = z.discriminatedUnion('provider', [
    z.strictObject({
        provider: z.literal('oci-registry'),
        /** The registry hosts reach, https only (the cell takes plain HTTP for a loopback host only). */
        endpoint: z.url().refine((u) => new URL(u).protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname), 'https only'),
        /** The first segments of every repository the store holds for this installation. */
        prefix: Prefix.default('kodus-ci'),
        /** The registry's `auth.token.service`; the token's audience. */
        service: z.string().min(1).max(128).default('kodus-image-store'),
        /** Short on purpose: a registry checks a signature, not a denylist, so expiry is the revocation. */
        tokenTtlSeconds: z.number().int().min(60).max(900).default(600),
    }),
    z.strictObject({ provider: z.literal('fake'), prefix: Prefix.default('fake-store'), tokenTtlSeconds: z.number().int().min(60).max(900).default(600) }),
]);
export type ImageStoreConfig = z.infer<typeof ImageStoreConfigSchema>;

/** What a repository holds: the default branch's images, one PR sha's image, or the BuildKit cache. */
export const STORE_SCOPES = ['main', 'pr', 'cache'] as const;
export type StoreScope = (typeof STORE_SCOPES)[number];

/** One repository a grant names, and what the credential may do there. */
export interface GrantRepo {
    scope: StoreScope;
    /** The full repository name, prefix included: what the registry's token names. */
    name: string;
    pull: boolean;
    push: boolean;
}

export interface StoreGrant {
    endpoint: string;
    prefix: string;
    /** A bearer token. Held in memory by the hub and the cell; never stored, logged or given to a builder. */
    token: string;
    expiresAt: string;
    repos: GrantRepo[];
}

export interface StoreEndpoint {
    endpoint: string;
    prefix: string;
}

export interface GrantRequest {
    claimId: string;
    organizationId: string;
    /** Already scoped by the hub from the claim's bound key (`planGrant`); a provider mints exactly this and nothing more. */
    repos: readonly GrantRepo[];
    ttlSeconds: number;
}

/** The hub-side port. Every method is safe to retry. A failure is an Error: the caller falls back to a cold build. */
export interface ImageStoreProvider {
    readonly kind: ImageStoreProviderKind;
    endpointFor(config: ImageStoreConfig): StoreEndpoint;
    grant(config: ImageStoreConfig, req: GrantRequest, now: Date): Promise<StoreGrant>;
    /** Stops renewing: the credential still lives until `expiresAt`, short by design. */
    revoke(claimId: string): Promise<void>;
}

/** The hash both sides name repositories with (the cell's `remotecache.hashOf`): length-prefixed parts, 32 hex. */
export function storeHash(...parts: string[]): string {
    const h = createHash('sha256');
    for (const p of parts) h.update(`${Buffer.byteLength(p)}:${p}`);
    return h.digest('hex').slice(0, 32);
}

/** The repository of a scope. The org's hash is its own segment, so an access rule grants one org and nothing more. */
export function storeRepoName(prefix: string, org: string, env: string, scope: StoreScope, sha?: string): string {
    const tail = scope === 'pr' ? `pr-${storeHash(sha ?? '')}` : scope;
    return `${prefix}/o-${storeHash(org)}/e-${storeHash(org, env)}/${tail}`;
}

export type BoundKeyKind = 'setup' | 'template' | 'run' | 'suite';

/** The kind of a perRun host's bound key, only when the key names the claim's own org: anything else is null. */
export function boundKeyKind(organizationId: string, key: string | null | undefined): BoundKeyKind | null {
    if (!key) return null;
    for (const kind of ['setup', 'template', 'run', 'suite'] as const) if (key.startsWith(`${kind}:${organizationId}/`)) return kind;
    return null;
}

export interface GrantScopeAsk {
    organizationId: string;
    environmentId: string;
    boundKey: string | null | undefined;
    side: 'base' | 'pr' | 'setup';
    sha: string;
}

/**
 * Who may read and write what (docs/runtime/shared-image-store.md section 4), from the claim's own bound key and
 * side, never from a cell's request. null: no grant (an unbound host, a key of another org). The PR side writes
 * its own sha's repository and nothing else, so S-52 holds: what a PR built never reaches `main` or `cache`.
 */
export function planGrant(ask: GrantScopeAsk, prefix: string): GrantRepo[] | null {
    const kind = boundKeyKind(ask.organizationId, ask.boundKey);
    if (!kind) return null;
    const repo = (scope: StoreScope, pull: boolean, push: boolean): GrantRepo => ({ scope, name: storeRepoName(prefix, ask.organizationId, ask.environmentId, scope, ask.sha), pull, push });
    switch (kind) {
        case 'setup':
            // Only the default branch's setup writes the layers, images and build cache others read; a PR's setup reads both and writes neither.
            return ask.side === 'pr' ? [repo('main', true, false), repo('cache', true, false)] : [repo('main', true, true), repo('cache', true, true)];
        case 'template':
            return [repo('main', true, false)];
        case 'run':
            return ask.side === 'pr' ? [repo('main', true, false), repo('cache', true, false), repo('pr', true, true)] : [repo('main', true, false)];
        case 'suite':
            return [repo('pr', true, false), repo('main', true, false)];
    }
}
