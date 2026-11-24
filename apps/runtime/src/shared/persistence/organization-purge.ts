import type { Pool } from 'pg';

// The Runtime Postgres half of an organization's purge (docs/runtime/architecture.md "Data lifecycle"): every row
// that names the organization, deleted in batches, after the live Runs are cancelled and the claims released (the
// handler, worker/commands/organization-purge.handler.ts). The worker owns this database, so the purge is here and
// not in the API.

/** The Postgres half of an organization's purge, as the worker module provides it. */
export const ORGANIZATION_PURGE_STORE = Symbol('ORGANIZATION_PURGE_STORE');

/** Rows one purge statement deletes at most: short transactions, never a long lock on the hub's appends. */
export const ORGANIZATION_PURGE_BATCH = 5_000;

/**
 * The tables that carry the organization in a column, each with that column (`runtime_machine_usage` is a view over
 * `runtime_machine_reservations`, so it empties with it). A new `runtime` table with an
 * `org_id` or `organization_id` column goes here (`organization-purge.integration.spec.ts` fails until it does).
 * Order matters only where a table is read by another's subquery (a Run's fork approval, a cell's revocations, a
 * host's events): those children are in `ORGANIZATION_PURGE_CHILDREN` and go first.
 */
export const ORGANIZATION_PURGE_TABLES: ReadonlyArray<readonly [table: string, column: 'org_id' | 'organization_id']> = [
    ['runtime_admission_requests', 'org_id'],
    ['runtime_bake_asks', 'org_id'],
    ['runtime_build_state_evictions', 'org_id'],
    ['runtime_cell_reservations', 'org_id'],
    ['runtime_cell_sessions', 'org_id'],
    ['runtime_cell_tokens', 'organization_id'],
    ['runtime_claim_blockers', 'org_id'],
    ['runtime_claims', 'org_id'],
    ['runtime_egress_approvals', 'organization_id'],
    ['runtime_egress_audit', 'organization_id'],
    ['runtime_egress_events', 'org_id'],
    ['runtime_egress_settings', 'organization_id'],
    ['runtime_env_sessions', 'organization_id'],
    ['runtime_env_steps', 'organization_id'],
    ['runtime_env_templates', 'org_id'],
    ['runtime_environment_setups', 'organization_id'],
    ['runtime_kept_check_results', 'org_id'],
    ['runtime_lessons', 'organization_id'],
    ['runtime_machine_reservations', 'org_id'],
    ['runtime_org_machine_budget', 'organization_id'],
    ['runtime_template_setups', 'organization_id'],
    ['runtime_pool_demand', 'organization_id'],
    ['runtime_pr_cancel_generations', 'organization_id'],
    ['runtime_pr_fences', 'organization_id'],
    ['runtime_pr_run_generations', 'organization_id'],
    ['runtime_preview_audit', 'org_id'],
    ['runtime_preview_sessions', 'org_id'],
    ['runtime_previews', 'org_id'],
    ['runtime_run_events', 'org_id'],
    ['runtime_runs', 'organization_id'],
    ['runtime_sandbox_audit', 'org_id'],
    ['runtime_shared_images', 'org_id'],
    ['runtime_snapshot_cells', 'org_id'],
    ['runtime_stability', 'org_id'],
    ['runtime_steps_index', 'org_id'],
    ['runtime_stops', 'organization_id'],
    ['runtime_suite_baseline_requests', 'organization_id'],
    ['runtime_suite_baselines', 'organization_id'],
    ['runtime_suite_coverage_maps', 'organization_id'],
    ['runtime_suite_results', 'organization_id'],
    ['runtime_suite_runs', 'organization_id'],
    ['runtime_suite_shards', 'organization_id'],
    ['runtime_suite_spec_stats', 'organization_id'],
    // Fleet rows: a host that is not terminated still has a machine at a provider, so it (and its pool) stays until
    // runtime-fleet tears it down; the purge reports it and a second purge removes it.
    ['runtime_hosts', 'organization_id'],
    ['runtime_host_pools', 'organization_id'],
    ['runtime_cells', 'organization_id'],
];

/** The org's tables with the SQL that selects their rows by the org's other rows (`$1` is the org). Deleted before their parents. */
export const ORGANIZATION_PURGE_CHILDREN: ReadonlyArray<readonly [table: string, where: string]> = [
    ['runtime_fork_approvals', `run_id IN (SELECT run_id FROM runtime.runtime_runs WHERE organization_id = $1)`],
    ['runtime_cell_revocations', `cell_id IN (SELECT cell_id FROM runtime.runtime_cells WHERE organization_id = $1)`],
    ['runtime_cell_sessions', `cell_id IN (SELECT cell_id FROM runtime.runtime_cells WHERE organization_id = $1)`],
    ['runtime_preview_tunnels', `cell_id IN (SELECT cell_id FROM runtime.runtime_cells WHERE organization_id = $1)`],
    ['runtime_host_events', `host_id IN (SELECT host_id FROM runtime.runtime_hosts WHERE organization_id = $1 AND state = 'terminated')`],
    ['runtime_fleet_tokens', `host_id IN (SELECT host_id FROM runtime.runtime_hosts WHERE organization_id = $1 AND state = 'terminated')`],
];

/** What the handler needs of the Runtime Postgres to purge an organization. */
export interface OrganizationPurgeStore {
    /** The organization's claims that were not released: machines that may still run. */
    liveClaims(organizationId: string): Promise<Array<{ claimId: string; runId: string | null }>>;
    /** Stops the organization's host pools from taking demand, so runtime-fleet drains their hosts. Returns the pools changed. */
    cordonPools(organizationId: string): Promise<number>;
    /** Deletes every row of the organization; rows deleted per table (only the tables that had any). */
    deleteOrganization(organizationId: string, batch?: number): Promise<{ deleted: Record<string, number>; hostsKept: number }>;
}

export class PgOrganizationPurgeStore implements OrganizationPurgeStore {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async liveClaims(organizationId: string) {
        const r = await this.pool.query(`SELECT claim_id, run_id FROM runtime.runtime_claims WHERE org_id = $1 AND released_at IS NULL LIMIT 1000`, [organizationId]);
        return r.rows.map((x) => ({ claimId: x.claim_id as string, runId: (x.run_id as string | null) ?? null }));
    }

    async cordonPools(organizationId: string) {
        const r = await this.pool.query(`UPDATE runtime.runtime_host_pools SET cordoned_at = now(), updated_at = now() WHERE organization_id = $1 AND cordoned_at IS NULL`, [organizationId]);
        return r.rowCount ?? 0;
    }

    async deleteOrganization(organizationId: string, batch = ORGANIZATION_PURGE_BATCH) {
        const deleted: Record<string, number> = {};
        const sweep = async (table: string, where: string) => {
            const n = await this.deleteWhere(table, where, organizationId, batch);
            if (n) deleted[table] = (deleted[table] ?? 0) + n;
        };
        for (const [table, where] of ORGANIZATION_PURGE_CHILDREN) await sweep(table, where);
        for (const [table, column] of ORGANIZATION_PURGE_TABLES) {
            if (table === 'runtime_hosts') await sweep(table, `organization_id = $1 AND state = 'terminated'`);
            // A pool that still has a host (one not terminated, kept above) stays with it.
            else if (table === 'runtime_host_pools') await sweep(table, `organization_id = $1 AND NOT EXISTS (SELECT 1 FROM runtime.runtime_hosts h WHERE h.pool_id = runtime_host_pools.pool_id)`);
            else await sweep(table, `${column} = $1`);
        }
        const kept = await this.pool.query(`SELECT count(*)::int AS n FROM runtime.runtime_hosts WHERE organization_id = $1`, [organizationId]);
        return { deleted, hostsKept: Number(kept.rows[0]?.n ?? 0) };
    }

    /** `where` binds `$1`; deletes `batch` rows a statement until one comes back short. */
    private async deleteWhere(table: string, where: string, organizationId: string, batch: number): Promise<number> {
        let removed = 0;
        for (;;) {
            const n = (await this.pool.query(`DELETE FROM runtime.${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM runtime.${table} WHERE ${where} LIMIT $2))`, [organizationId, batch])).rowCount ?? 0;
            removed += n;
            if (n < batch) return removed;
        }
    }
}
