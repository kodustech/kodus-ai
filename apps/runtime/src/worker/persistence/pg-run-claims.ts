import type { Pool } from 'pg';

import type { HardExpiredClaims } from '../dbos/run-deps.factory';
import type { RunClaims } from '../run/ports';

/**
 * runtime_claims and runtime_egress_events as the worker reads them. The hub
 * is the only writer of claims (it records them on acquire and on release),
 * so this has no write.
 */
export class PgRunClaims implements RunClaims, HardExpiredClaims {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async forRun(runId: string) {
        const r = await this.pool.query(`SELECT claim_id, side FROM runtime.runtime_claims WHERE run_id = $1 AND released_at IS NULL`, [runId]);
        return r.rows.map((x) => ({ claimId: x.claim_id as string, side: x.side as string }));
    }

    async egressBlocked(claimIds: string[]) {
        if (!claimIds.length) return [];
        const r = await this.pool.query(`SELECT host, port, phase FROM runtime.runtime_egress_events WHERE claim_id = ANY($1::text[]) ORDER BY at`, [claimIds]);
        return r.rows as { host: string; port: number; phase: string }[];
    }

    async securityViolations(claimIds: string[]) {
        if (!claimIds.length) return [];
        const r = await this.pool.query(
            `SELECT claim_id, side, signature FROM runtime.runtime_claim_blockers WHERE kind = 'security_violation' AND claim_id = ANY($1::text[]) ORDER BY at`,
            [claimIds],
        );
        return r.rows.map((x) => ({ claimId: x.claim_id as string, side: x.side as string, signature: x.signature as string }));
    }

    /** Claims past their hard expiry that nobody released (input of the reaper), oldest first. */
    async hardExpired(now: Date) {
        const r = await this.pool.query(
            `SELECT claim_id, cell_id, org_id, run_id FROM runtime.runtime_claims
              WHERE released_at IS NULL AND hard_expires_at < $1 ORDER BY hard_expires_at LIMIT 100`,
            [now],
        );
        return r.rows.map((x) => ({ claimId: x.claim_id as string, cellId: x.cell_id as string, orgId: x.org_id as string, runId: (x.run_id as string | null) ?? null }));
    }

    /** The hub replicas that hold a live claim of the environment (where an approved egress host goes). */
    async replicasOfEnvironment(organizationId: string, environmentId: string): Promise<string[]> {
        const r = await this.pool.query(
            `SELECT DISTINCT s.replica_url FROM runtime.runtime_claims c
               JOIN runtime.runtime_cell_sessions s ON s.cell_id = c.cell_id AND s.disconnected_at IS NULL
              WHERE c.org_id = $1 AND c.environment_id = $2 AND c.state = 'bound' AND c.hard_expires_at > now()`,
            [organizationId, environmentId],
        );
        return r.rows.map((x) => x.replica_url as string);
    }
}
