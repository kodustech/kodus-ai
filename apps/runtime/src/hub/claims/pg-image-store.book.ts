import type { Pool } from 'pg';

import type { GrantRecord, ImageStoreBook, PrImage, PrImageRow } from './image-store.service';

/** The grants audit and the PR image rows in the Runtime Postgres (migration 63). The hub is the only writer. */
export class PgImageStoreBook implements ImageStoreBook {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async recordGrant(g: GrantRecord): Promise<void> {
        // A retry of the acquire round mints again for the same claim: the row follows the newest grant and keeps its history count.
        await this.pool.query(
            `INSERT INTO runtime.runtime_image_store_grants (claim_id, org_id, environment_id, pool_id, provider, sha, repos, issued_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
             ON CONFLICT (claim_id) DO UPDATE SET pool_id = EXCLUDED.pool_id, provider = EXCLUDED.provider, repos = EXCLUDED.repos, expires_at = EXCLUDED.expires_at, revoked_at = NULL
             WHERE runtime.runtime_image_store_grants.org_id = EXCLUDED.org_id`,
            [g.claimId, g.orgId, g.environmentId, g.poolId, g.provider, g.sha, JSON.stringify(g.repos), g.issuedAt, g.expiresAt],
        );
    }

    async grantOf(claimId: string): Promise<GrantRecord | null> {
        const r = await this.pool.query(
            `SELECT claim_id, org_id, environment_id, pool_id, provider, sha, repos, issued_at, expires_at, renewals FROM runtime.runtime_image_store_grants WHERE claim_id = $1 AND revoked_at IS NULL`,
            [claimId],
        );
        const x = r.rows[0];
        return x
            ? { claimId: x.claim_id, orgId: x.org_id, environmentId: x.environment_id, poolId: x.pool_id, provider: x.provider, sha: x.sha, repos: x.repos, issuedAt: new Date(x.issued_at).toISOString(), expiresAt: new Date(x.expires_at).toISOString(), renewals: Number(x.renewals) }
            : null;
    }

    async renewGrant(claimId: string, expiresAt: string): Promise<boolean> {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_image_store_grants SET expires_at = GREATEST(expires_at, $2), renewals = renewals + 1 WHERE claim_id = $1 AND revoked_at IS NULL`,
            [claimId, expiresAt],
        );
        return (r.rowCount ?? 0) > 0;
    }

    async revokeGrant(claimId: string, at: string): Promise<void> {
        await this.pool.query(`UPDATE runtime.runtime_image_store_grants SET revoked_at = $2 WHERE claim_id = $1 AND revoked_at IS NULL`, [claimId, at]);
    }

    async startPrImage(r: { orgId: string; environmentId: string; prSha: string; builderClaim: string; expiresAt: string }): Promise<void> {
        await this.pool.query(
            `INSERT INTO runtime.runtime_pr_images (org_id, environment_id, pr_sha, state, builder_claim, expires_at) VALUES ($1, $2, $3, 'pending', $4, $5)
             ON CONFLICT (org_id, environment_id, pr_sha) DO UPDATE SET
                state = 'pending', builder_claim = EXCLUDED.builder_claim, images = '[]'::jsonb, reason = NULL, ready_at = NULL, expires_at = EXCLUDED.expires_at
              WHERE runtime.runtime_pr_images.state <> 'ready'`,
            [r.orgId, r.environmentId, r.prSha, r.builderClaim, r.expiresAt],
        );
    }

    async finishPrImage(r: { orgId: string; environmentId: string; prSha: string; builderClaim: string; state: 'ready' | 'failed'; images: PrImage[]; reason?: string }): Promise<boolean> {
        const q = await this.pool.query(
            `UPDATE runtime.runtime_pr_images SET state = $5, images = $6::jsonb, reason = $7, ready_at = CASE WHEN $5 = 'ready' THEN now() END
              WHERE org_id = $1 AND environment_id = $2 AND pr_sha = $3 AND builder_claim = $4 AND state = 'pending'`,
            [r.orgId, r.environmentId, r.prSha, r.builderClaim, r.state, JSON.stringify(r.images), r.reason ?? null],
        );
        return (q.rowCount ?? 0) > 0;
    }

    async failPendingOf(builderClaim: string, reason: string): Promise<number> {
        const q = await this.pool.query(`UPDATE runtime.runtime_pr_images SET state = 'failed', reason = $2 WHERE builder_claim = $1 AND state = 'pending'`, [builderClaim, reason]);
        return q.rowCount ?? 0;
    }

    async prImage(orgId: string, environmentId: string, prSha: string): Promise<PrImageRow | null> {
        const r = await this.pool.query(
            `SELECT org_id, environment_id, pr_sha, state, builder_claim, images, reason FROM runtime.runtime_pr_images WHERE org_id = $1 AND environment_id = $2 AND pr_sha = $3 AND expires_at > now()`,
            [orgId, environmentId, prSha],
        );
        const x = r.rows[0];
        return x ? { orgId: x.org_id, environmentId: x.environment_id, prSha: x.pr_sha, state: x.state, builderClaim: x.builder_claim, images: x.images, reason: x.reason } : null;
    }
}
