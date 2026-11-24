import type { Pool } from 'pg';

import type { TemplateResolver } from '../per-run-host';

// runtime_env_templates (docs/runtime/host-providers.md §8.2): which saved
// snapshot each environment's Run hosts start from, per pool. runtime-fleet
// is the only writer. One ready template per environment and pool; a newer
// one replaces the older, whose snapshot is then deleted at the provider.
// A template holds the cell of the base its setup host booted (`cellBase`):
// once the pool moves to another base it is no ready template, so Run hosts
// boot the new cell and the next build replaces it (migration 61).

export type TemplateState = 'building' | 'ready' | 'failed' | 'replaced';

export interface TemplateRow {
    organizationId: string;
    environmentId: string;
    poolId: string;
    fingerprint: string;
    name: string;
    state: TemplateState;
    /** The pool's cell base the template was built from; '' for a row from before migration 61. */
    cellBase: string;
}

type TemplateKey = Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>;

export interface TemplateStore {
    find(organizationId: string, environmentId: string, poolId: string, fingerprint: string): Promise<TemplateRow | null>;
    /** The newest ready template built from `cellBase`, the pool's base now; one of another base is not served. */
    readyName(organizationId: string, environmentId: string, poolId: string, cellBase: string): Promise<string | null>;
    /**
     * Marks the template building on `setupHostId`, the setup host about to be created (written before it exists). A
     * ready row of another cell base is taken over too: its snapshot is kept as the one to delete once this one is promoted.
     * false: another build holds the row (building, not stale), or it is ready on this base; this one must not boot a host.
     */
    begin(t: Omit<TemplateRow, 'state'> & { setupHostId?: string }): Promise<boolean>;
    /** The setup hosts of the templates building now (recently touched): the orphan pass spares them. */
    buildingSetupHosts(): Promise<string[]>;
    fail(t: TemplateKey, reason: string): Promise<void>;
    /** Marks this template ready and every other ready one of its environment and pool replaced; the snapshots to delete (theirs, and the one this build took over). */
    promote(t: TemplateKey): Promise<string[]>;
    /** Whether this fingerprint needs no build now: a template ready on `cellBase` or building holds it, or its build failed after `failedAfter`. */
    holds(t: TemplateKey & { cellBase: string }, failedAfter: Date): Promise<boolean>;
}

export class PgTemplateStore implements TemplateStore {
    constructor(private readonly db: Pick<Pool, 'query'>) {}

    async find(organizationId: string, environmentId: string, poolId: string, fingerprint: string) {
        const x = (await this.db.query(`SELECT * FROM runtime.runtime_env_templates WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint = $4`, [organizationId, environmentId, poolId, fingerprint])).rows[0];
        return x ? { organizationId: x.org_id, environmentId: x.environment_id, poolId: x.pool_id, fingerprint: x.fingerprint, name: x.snapshot_name, state: x.state, cellBase: x.cell_base ?? '' } : null;
    }

    async readyName(organizationId: string, environmentId: string, poolId: string, cellBase: string) {
        const r = await this.db.query(
            `SELECT snapshot_name FROM runtime.runtime_env_templates WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND state = 'ready' AND cell_base = $4 ORDER BY ready_at DESC LIMIT 1`,
            [organizationId, environmentId, poolId, cellBase],
        );
        return (r.rows[0]?.snapshot_name as string | undefined) ?? null;
    }

    async begin(t: Omit<TemplateRow, 'state'> & { setupHostId?: string }) {
        const r = await this.db.query(
            `INSERT INTO runtime.runtime_env_templates (org_id, environment_id, pool_id, fingerprint, snapshot_name, state, setup_host_id, cell_base) VALUES ($1, $2, $3, $4, $5, 'building', $6, $7)
             ON CONFLICT (org_id, environment_id, pool_id, fingerprint) DO UPDATE SET state = 'building', failure = NULL, setup_key = NULL, setup_requested_at = NULL, setup_host_id = EXCLUDED.setup_host_id,
                 snapshot_name = EXCLUDED.snapshot_name, cell_base = EXCLUDED.cell_base,
                 retired_snapshot = CASE WHEN runtime_env_templates.state = 'ready' AND runtime_env_templates.snapshot_name <> EXCLUDED.snapshot_name THEN runtime_env_templates.snapshot_name ELSE runtime_env_templates.retired_snapshot END,
                 updated_at = now()
             WHERE runtime_env_templates.state IN ('failed', 'replaced')
                OR (runtime_env_templates.state = 'building' AND runtime_env_templates.updated_at < now() - interval '3 hours')
                OR (runtime_env_templates.state = 'ready' AND runtime_env_templates.cell_base IS DISTINCT FROM EXCLUDED.cell_base)
             RETURNING 1`,
            [t.organizationId, t.environmentId, t.poolId, t.fingerprint, t.name, t.setupHostId ?? null, t.cellBase],
        );
        return (r.rowCount ?? 0) > 0;
    }

    async buildingSetupHosts() {
        // A build waits at most an hour for its bake (runtime-fleet.module.ts poll): an older building row is a dead
        // build, and its host is an orphan.
        const r = await this.db.query(
            `SELECT setup_host_id FROM runtime.runtime_env_templates WHERE state = 'building' AND setup_host_id IS NOT NULL AND updated_at > now() - interval '3 hours'`,
        );
        return r.rows.map((x: { setup_host_id: string }) => x.setup_host_id);
    }

    async fail(t: TemplateKey, reason: string) {
        await this.db.query(`UPDATE runtime.runtime_env_templates SET state = 'failed', failure = $5, updated_at = now() WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint = $4 AND state = 'building'`, [t.organizationId, t.environmentId, t.poolId, t.fingerprint, reason]);
    }

    async holds(t: TemplateKey & { cellBase: string }, failedAfter: Date) {
        const r = await this.db.query(
            `SELECT 1 FROM runtime.runtime_env_templates WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint = $4
               AND ((state = 'ready' AND cell_base = $6) OR (state = 'building' AND updated_at > now() - interval '3 hours') OR (state = 'failed' AND updated_at > $5)) LIMIT 1`,
            [t.organizationId, t.environmentId, t.poolId, t.fingerprint, failedAfter, t.cellBase],
        );
        return r.rows.length > 0;
    }

    async promote(t: TemplateKey) {
        // The snapshot of the other base this build took over (begin) goes with the replaced ones.
        const own = await this.db.query(
            `UPDATE runtime.runtime_env_templates n SET state = 'ready', ready_at = now(), updated_at = now(), retired_snapshot = NULL
               FROM runtime.runtime_env_templates o
              WHERE n.org_id = $1 AND n.environment_id = $2 AND n.pool_id = $3 AND n.fingerprint = $4
                AND o.org_id = n.org_id AND o.environment_id = n.environment_id AND o.pool_id = n.pool_id AND o.fingerprint = n.fingerprint
              RETURNING o.retired_snapshot`,
            [t.organizationId, t.environmentId, t.poolId, t.fingerprint],
        );
        const retired = (own.rows[0]?.retired_snapshot as string | null | undefined) ?? null;
        const r = await this.db.query(
            `UPDATE runtime.runtime_env_templates SET state = 'replaced', replaced_at = now(), updated_at = now()
              WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint <> $4 AND state = 'ready' RETURNING snapshot_name`,
            [t.organizationId, t.environmentId, t.poolId, t.fingerprint],
        );
        return [...r.rows.map((x) => x.snapshot_name as string), ...(retired ? [retired] : [])];
    }
}

/** What a Run host starts from: the environment's ready template on that pool. */
export class StoreTemplateResolver implements TemplateResolver {
    constructor(private readonly store: Pick<TemplateStore, 'readyName'>) {}

    async resolve(req: { organizationId: string; environmentId: string | null; poolId: string; cellBase?: string }) {
        return req.environmentId ? this.store.readyName(req.organizationId, req.environmentId, req.poolId, req.cellBase ?? '') : null;
    }
}
