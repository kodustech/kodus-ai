import type { ClaimState } from '@libs/runtime/contracts/enums';
import { LIVE_CLAIM_STATES } from '@libs/runtime/contracts/enums';
import { boundKeyKind, type GrantRepo, type ImageStoreConfig, type ImageStoreProvider, planGrant, type StoreGrant } from '@libs/runtime/fleet/image-store';
import type { ImageStoreGrant, MessageBody, SharedImage } from '@libs/runtime/protocol';

import { supports } from '../cell-capabilities';
import type { CellSession, ClaimRow } from '../hub-store';
import type { HubLog } from '../hub-types';

// The hub's side of the shared image store (docs/runtime/shared-image-store.md): it mints a short-lived credential
// with the claim, scoped from the claim's own bound key, renews it with the claim's lease, records the digest of the
// PR image the builder pushed and gives it to the suite's shards. The store only makes things faster: every failure
// here is logged and counted and the claim goes on without it, building as before.

/** The 48 h hard end of a PR image row (the design's section 5 item 6). */
export const PR_IMAGE_HARD_TTL_MS = 48 * 3_600_000;

export interface PrImage {
    fingerprint: string;
    digest: string;
    bytes: number;
    pushMs: number;
}

export type PrImageState = 'pending' | 'ready' | 'failed';

export interface PrImageRow {
    orgId: string;
    environmentId: string;
    prSha: string;
    state: PrImageState;
    builderClaim: string;
    images: PrImage[];
    reason?: string | null;
}

/** What the hub keeps of a grant: never the token. */
export interface GrantRecord {
    claimId: string;
    orgId: string;
    environmentId: string;
    poolId: string;
    provider: string;
    sha: string;
    repos: GrantRepo[];
    issuedAt: string;
    expiresAt: string;
    renewals: number;
}

/** Grants audited and PR image rows: the port the Pg store and the in-memory double (hub/testing.ts) implement. */
export interface ImageStoreBook {
    recordGrant(g: GrantRecord): Promise<void>;
    /** The grant of a claim that was not revoked. */
    grantOf(claimId: string): Promise<GrantRecord | null>;
    /** Moves the expiry forward and counts the renewal; false when the grant is unknown or revoked. */
    renewGrant(claimId: string, expiresAt: string): Promise<boolean>;
    revokeGrant(claimId: string, at: string): Promise<void>;
    /** The builder claim asks to push: `pending` unless the sha already has a ready image. */
    startPrImage(r: { orgId: string; environmentId: string; prSha: string; builderClaim: string; expiresAt: string }): Promise<void>;
    /** Only the row's builder claim, only while pending: true when it settled the row. */
    finishPrImage(r: { orgId: string; environmentId: string; prSha: string; builderClaim: string; state: 'ready' | 'failed'; images: PrImage[]; reason?: string }): Promise<boolean>;
    /** The builder ended without a result: its pending rows are failed. */
    failPendingOf(builderClaim: string, reason: string): Promise<number>;
    prImage(orgId: string, environmentId: string, prSha: string): Promise<PrImageRow | null>;
}

/** The pool's `imageStore` block, as the fleet stored it with the pool's spec. */
export interface PoolImageStores {
    imageStoreOf(poolId: string): Promise<ImageStoreConfig | null>;
}

export interface ImageStoreMetrics {
    imageStoreGrant(outcome: 'minted_read' | 'minted_write' | 'renewed' | 'failed' | 'no_provider'): void;
    imageStorePrImage(outcome: 'ready' | 'failed' | 'waited_ready' | 'waited_failed' | 'waited_timeout'): void;
}

export interface PreparedImageStore {
    grant: StoreGrant;
    /** The PR image's digests the claim pulls instead of building (a suite shard), when the builder's are ready. */
    prImages?: SharedImage[];
}

export type StoreAsk = {
    organizationId: string;
    environmentId: string;
    consumer: string;
    ref: { side: 'base' | 'pr' | 'setup'; sha: string };
};

const toWire = (g: StoreGrant): ImageStoreGrant => ({ endpoint: g.endpoint, prefix: g.prefix, token: g.token, expiresAt: g.expiresAt, repos: g.repos });

export class ImageStoreService {
    constructor(
        private readonly deps: {
            book: ImageStoreBook;
            pools: PoolImageStores;
            /** The provider for a config's kind, or undefined when this hub cannot serve it (no signing key). */
            providerFor: (config: ImageStoreConfig) => ImageStoreProvider | undefined;
            claimState: (claimId: string) => Promise<ClaimState | null>;
            metrics: ImageStoreMetrics;
            log: HubLog;
            now: () => Date;
            /** The longest a shard waits for its builder's image (RUNTIME_PR_IMAGE_WAIT_SECONDS). */
            waitMs: number;
            pollMs?: number;
            sleep?: (ms: number) => Promise<void>;
        },
    ) {}

    /**
     * The grant for a claim about to be acquired, and the digests it pulls. undefined: no store for this claim (the pool has
     * none, the cell does not name the feature, the claim has no bound key of its org, anything failed): it builds as before.
     * Awaits the builder's push for a suite shard, so it runs before the claim is admitted, holding no memory while it waits.
     */
    async prepare(session: CellSession, req: StoreAsk, ids: { claimId: string; cellId: string }): Promise<PreparedImageStore | undefined> {
        if (!supports(session, 'imageStore') || !session.poolId || !['runtime', 'setup', 'suite'].includes(req.consumer)) return undefined;
        const kind = boundKeyKind(req.organizationId, session.boundKey);
        if (!kind) return undefined;
        const log = (level: 'info' | 'warn', msg: string, extra: Record<string, unknown> = {}) => this.deps.log(level, msg, { ...ids, orgId: req.organizationId, environmentId: req.environmentId, ...extra });
        try {
            const config = await this.deps.pools.imageStoreOf(session.poolId);
            if (!config) return undefined;
            const provider = this.deps.providerFor(config);
            if (!provider) {
                log('warn', 'image_store.no_provider', { provider: config.provider });
                this.deps.metrics.imageStoreGrant('no_provider');
                return undefined;
            }
            const repos = planGrant({ organizationId: req.organizationId, environmentId: req.environmentId, boundKey: session.boundKey, side: req.ref.side, sha: req.ref.sha }, provider.endpointFor(config).prefix);
            if (!repos) return undefined;
            const writes = repos.some((r) => r.push);
            const now = this.deps.now();
            const grant = await provider.grant(config, { claimId: ids.claimId, organizationId: req.organizationId, repos, ttlSeconds: config.tokenTtlSeconds }, now);
            await this.deps.book.recordGrant({ claimId: ids.claimId, orgId: req.organizationId, environmentId: req.environmentId, poolId: session.poolId, provider: provider.kind, sha: req.ref.sha, repos, issuedAt: now.toISOString(), expiresAt: grant.expiresAt, renewals: 0 });
            this.deps.metrics.imageStoreGrant(writes ? 'minted_write' : 'minted_read');
            log('info', 'image_store.grant', { kind, repos: repos.map((r) => `${r.scope}:${r.push ? 'rw' : 'r'}`), expiresAt: grant.expiresAt });
            if (writes && repos.some((r) => r.scope === 'pr' && r.push)) {
                await this.deps.book.startPrImage({ orgId: req.organizationId, environmentId: req.environmentId, prSha: req.ref.sha, builderClaim: ids.claimId, expiresAt: new Date(now.getTime() + PR_IMAGE_HARD_TTL_MS).toISOString() });
            }
            const prImages = kind === 'suite' ? await this.awaitPrImages(req, ids.claimId, log) : undefined;
            return { grant, ...(prImages?.length ? { prImages: prImages.map((i) => ({ fingerprint: i.fingerprint, digest: i.digest })) } : {}) };
        } catch (e) {
            this.deps.metrics.imageStoreGrant('failed');
            log('warn', 'image_store.grant_failed', { error: (e as Error).message });
            return undefined;
        }
    }

    /** The wire form of a prepared store, for claim.acquire. */
    static wire(p: PreparedImageStore): { grant: ImageStoreGrant; prImages?: SharedImage[] } {
        return { grant: toWire(p.grant), ...(p.prImages ? { prImages: p.prImages } : {}) };
    }

    /**
     * The shard's wait for its PR's image: none when no builder asked to push, the digests when ready, nothing (it builds)
     * when the push failed, the builder's claim ended without a result, or the wait passed its cap.
     */
    private async awaitPrImages(req: StoreAsk, claimId: string, log: (l: 'info' | 'warn', m: string, e?: Record<string, unknown>) => void): Promise<PrImage[] | undefined> {
        const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const started = this.deps.now().getTime();
        let waited = false;
        for (;;) {
            const row = await this.deps.book.prImage(req.organizationId, req.environmentId, req.ref.sha);
            if (!row) return undefined;
            if (row.state === 'ready') {
                this.deps.metrics.imageStorePrImage(waited ? 'waited_ready' : 'ready');
                return row.images;
            }
            if (row.state === 'failed') {
                this.deps.metrics.imageStorePrImage(waited ? 'waited_failed' : 'failed');
                return undefined;
            }
            // Pending: the builder may have ended through a path that never told this service (a revocation, a lease sweep).
            const builder = await this.deps.claimState(row.builderClaim);
            if (builder === null || !LIVE_CLAIM_STATES.includes(builder)) {
                await this.deps.book.failPendingOf(row.builderClaim, 'builder_ended');
                continue;
            }
            if (this.deps.now().getTime() - started >= this.deps.waitMs) {
                this.deps.metrics.imageStorePrImage('waited_timeout');
                log('warn', 'image_store.pr_image_wait_timeout', { builderClaim: row.builderClaim, waitedMs: this.deps.now().getTime() - started });
                return undefined;
            }
            waited = true;
            await sleep(this.deps.pollMs ?? 2_000);
        }
    }

    /** The claim's credential renewed with its lease (claim.renew imageStoreGrant); undefined when it has none or cannot be renewed. */
    async renewal(claim: ClaimRow, session: CellSession | null): Promise<ImageStoreGrant | undefined> {
        if (!session || !supports(session, 'imageStore')) return undefined;
        try {
            const rec = await this.deps.book.grantOf(claim.claimId);
            if (!rec) return undefined;
            const config = await this.deps.pools.imageStoreOf(rec.poolId);
            const provider = config ? this.deps.providerFor(config) : undefined;
            if (!config || !provider) return undefined;
            const now = this.deps.now();
            const grant = await provider.grant(config, { claimId: rec.claimId, organizationId: rec.orgId, repos: rec.repos, ttlSeconds: config.tokenTtlSeconds }, now);
            if (!(await this.deps.book.renewGrant(rec.claimId, grant.expiresAt))) return undefined;
            this.deps.metrics.imageStoreGrant('renewed');
            return toWire(grant);
        } catch (e) {
            this.deps.metrics.imageStoreGrant('failed');
            this.deps.log('warn', 'image_store.renew_failed', { claimId: claim.claimId, error: (e as Error).message });
            return undefined;
        }
    }

    /** The claim ended: no more renewals, and a PR image it never finished is failed so its shards stop waiting. */
    async onClaimEnded(claimId: string): Promise<void> {
        try {
            const rec = await this.deps.book.grantOf(claimId);
            if (!rec) return;
            await this.deps.book.revokeGrant(claimId, this.deps.now().toISOString());
            const config = await this.deps.pools.imageStoreOf(rec.poolId);
            await (config ? this.deps.providerFor(config) : undefined)?.revoke(claimId);
            if ((await this.deps.book.failPendingOf(claimId, 'builder_ended')) > 0) this.deps.metrics.imageStorePrImage('failed');
        } catch (e) {
            this.deps.log('warn', 'image_store.revoke_failed', { claimId, error: (e as Error).message });
        }
    }

    /** `image.pushed` from the builder's cell: recorded only for the claim that asked to push this sha. */
    async onPushed(claim: ClaimRow, body: MessageBody<'image.pushed'>): Promise<'recorded' | 'ignored'> {
        const rec = await this.deps.book.grantOf(claim.claimId);
        if (!rec || !claim.environmentId || !rec.repos.some((r) => r.scope === 'pr' && r.push)) return 'ignored';
        const state = body.status === 'ok' && body.images.length > 0 ? 'ready' : 'failed';
        const settled = await this.deps.book.finishPrImage({ orgId: claim.orgId, environmentId: claim.environmentId, prSha: rec.sha, builderClaim: claim.claimId, state, images: body.images, ...(body.reason ? { reason: body.reason } : {}) });
        if (!settled) return 'ignored';
        this.deps.metrics.imageStorePrImage(state);
        return 'recorded';
    }
}
