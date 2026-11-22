import { ORG_EGRESS_SCOPE } from '@libs/runtime/contracts/egress';
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

    async forRun(organizationId: string, runId: string) {
        const r = await this.pool.query(`SELECT claim_id, side FROM runtime.runtime_claims WHERE run_id = $1 AND org_id = $2 AND released_at IS NULL`, [runId, organizationId]);
        return r.rows.map((x) => ({ claimId: x.claim_id as string, side: x.side as string }));
    }

    async egressBlocked(organizationId: string, claimIds: string[]) {
        if (!claimIds.length) return [];
        const r = await this.pool.query(`SELECT host, port, phase FROM runtime.runtime_egress_events WHERE claim_id = ANY($1::text[]) AND org_id = $2 ORDER BY at`, [
            claimIds,
            organizationId,
        ]);
        return r.rows as { host: string; port: number; phase: string }[];
    }

    async deniedEgressOfRun(organizationId: string, runId: string) {
        // A failed claim keeps its row (the hub records it on acquire): a PR side that never booted is here too.
        const r = await this.pool.query(
            `SELECT c.side, e.host FROM runtime.runtime_claims c
               JOIN runtime.runtime_egress_events e ON e.claim_id = c.claim_id AND e.org_id = c.org_id
              WHERE c.run_id = $1 AND c.org_id = $2
              ORDER BY e.at, e.id LIMIT 500`,
            [runId, organizationId],
        );
        return r.rows.map((x) => ({ side: x.side as string, host: x.host as string }));
    }

    async securityViolations(organizationId: string, claimIds: string[]) {
        if (!claimIds.length) return [];
        const r = await this.pool.query(
            `SELECT claim_id, side, signature FROM runtime.runtime_claim_blockers WHERE kind = 'security_violation' AND claim_id = ANY($1::text[]) AND org_id = $2 ORDER BY at`,
            [claimIds, organizationId],
        );
        return r.rows.map((x) => ({ claimId: x.claim_id as string, side: x.side as string, signature: x.signature as string }));
    }

    async hardExpiryOf(organizationId: string, claimId: string) {
        const r = await this.pool.query(`SELECT hard_expires_at FROM runtime.runtime_claims WHERE claim_id = $1 AND org_id = $2`, [claimId, organizationId]);
        const at = r.rows[0]?.hard_expires_at as Date | string | undefined;
        return at === undefined ? undefined : new Date(at).toISOString();
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

    /** The hub replicas that hold a connected cell: where an org's cell data purge goes. */
    async connectedReplicas(): Promise<string[]> {
        const r = await this.pool.query(`SELECT DISTINCT replica_url FROM runtime.runtime_cell_sessions WHERE disconnected_at IS NULL`);
        return r.rows.map((x) => x.replica_url as string);
    }

    /** The hub replicas that hold a live claim of the environment (where an approved egress host goes); of any environment for the org list. */
    async replicasOfEnvironment(organizationId: string, environmentId: string): Promise<string[]> {
        const r = await this.pool.query(
            `SELECT DISTINCT s.replica_url FROM runtime.runtime_claims c
               JOIN runtime.runtime_cell_sessions s ON s.cell_id = c.cell_id AND s.disconnected_at IS NULL
              WHERE c.org_id = $1 AND ($2::text = $3::text OR c.environment_id = $2::text) AND c.state = 'bound' AND c.hard_expires_at > now()`,
            [organizationId, environmentId, ORG_EGRESS_SCOPE],
        );
        return r.rows.map((x) => x.replica_url as string);
    }
}
