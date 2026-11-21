import type { Pool } from 'pg';

import type { FleetTokenRecord, FleetTokenStore } from '@libs/runtime/contracts/fleet-token';

// runtime_fleet_tokens (docs/runtime/host-providers.md §8.1): one row per
// host, the token's hash only. The hub is its only writer: it mints for
// runtime-fleet and burns at registration, in the transaction that inserts
// the cell (PgHubStore.redeemFleetAndRegister).

export class PgFleetTokenStore implements FleetTokenStore {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async issue(t: FleetTokenRecord): Promise<'issued' | 'already_registered'> {
        // A host's unused token is replaced (a mint retried before the host was created); a used one never is.
        const r = await this.pool.query(
            `INSERT INTO runtime.runtime_fleet_tokens AS t (token_hash, pool_id, host_id, bound_key, expires_at, issued_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (host_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, pool_id = EXCLUDED.pool_id, bound_key = EXCLUDED.bound_key,
               expires_at = EXCLUDED.expires_at, issued_by = EXCLUDED.issued_by, issued_at = now()
             WHERE t.used_at IS NULL
             RETURNING token_hash`,
            [t.tokenHash, t.poolId, t.hostId, t.boundKey, t.expiresAt, t.issuedBy],
        );
        return r.rowCount === 1 ? 'issued' : 'already_registered';
    }

    async consume(tokenHash: string, now: Date): Promise<FleetTokenRecord | null> {
        const r = await this.pool.query(`UPDATE runtime.runtime_fleet_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL RETURNING *`, [tokenHash, now]);
        const x = r.rows[0];
        return x
            ? { tokenHash: x.token_hash, poolId: x.pool_id, hostId: x.host_id, boundKey: x.bound_key, expiresAt: x.expires_at.toISOString(), issuedBy: x.issued_by, usedAt: now.toISOString() }
            : null;
    }
}
