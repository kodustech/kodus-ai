import type { Pool } from 'pg';

import type { TemplateResolver } from '../per-run-host';

// runtime_env_templates (docs/runtime/host-providers.md §8.2): which saved
// snapshot each environment's Run hosts start from, per pool. runtime-fleet
// is the only writer. One ready template per environment and pool; a newer
// one replaces the older, whose snapshot is then deleted at the provider.

export type TemplateState = 'building' | 'ready' | 'failed' | 'replaced';

export interface TemplateRow {
    organizationId: string;
    environmentId: string;
    poolId: string;
    fingerprint: string;
    name: string;
    state: TemplateState;
}

export interface TemplateStore {
    find(organizationId: string, environmentId: string, poolId: string, fingerprint: string): Promise<TemplateRow | null>;
    readyName(organizationId: string, environmentId: string, poolId: string): Promise<string | null>;
    /** Marks the template building on `setupHostId`, the setup host about to be created (written before it exists). */
    begin(t: Omit<TemplateRow, 'state'> & { setupHostId?: string }): Promise<void>;
    /** The setup hosts of the templates building now (recently touched): the orphan pass spares them. */
    buildingSetupHosts(): Promise<string[]>;
    fail(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>, reason: string): Promise<void>;
    /** Marks this template ready and every other ready one of its environment and pool replaced; their names. */
    promote(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>): Promise<string[]>;
    /** Whether this fingerprint needs no build now: a ready or building template holds it, or its build failed after `failedAfter`. */
    holds(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>, failedAfter: Date): Promise<boolean>;
}

export class PgTemplateStore implements TemplateStore {
    constructor(private readonly db: Pick<Pool, 'query'>) {}

    async find(organizationId: string, environmentId: string, poolId: string, fingerprint: string) {
        const x = (await this.db.query(`SELECT * FROM runtime.runtime_env_templates WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint = $4`, [organizationId, environmentId, poolId, fingerprint])).rows[0];
        return x ? { organizationId: x.org_id, environmentId: x.environment_id, poolId: x.pool_id, fingerprint: x.fingerprint, name: x.snapshot_name, state: x.state } : null;
    }

    async readyName(organizationId: string, environmentId: string, poolId: string) {
        const r = await this.db.query(`SELECT snapshot_name FROM runtime.runtime_env_templates WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND state = 'ready' ORDER BY ready_at DESC LIMIT 1`, [organizationId, environmentId, poolId]);
        return (r.rows[0]?.snapshot_name as string | undefined) ?? null;
    }

    async begin(t: Omit<TemplateRow, 'state'> & { setupHostId?: string }) {
        await this.db.query(
            `INSERT INTO runtime.runtime_env_templates (org_id, environment_id, pool_id, fingerprint, snapshot_name, state, setup_host_id) VALUES ($1, $2, $3, $4, $5, 'building', $6)
             ON CONFLICT (org_id, environment_id, pool_id, fingerprint) DO UPDATE SET state = 'building', failure = NULL, setup_key = NULL, setup_requested_at = NULL, setup_host_id = EXCLUDED.setup_host_id, updated_at = now() WHERE runtime_env_templates.state IN ('failed', 'replaced')`,
            [t.organizationId, t.environmentId, t.poolId, t.fingerprint, t.name, t.setupHostId ?? null],
        );
    }

    async buildingSetupHosts() {
        // A build waits at most an hour for its bake (runtime-fleet.module.ts poll): an older building row is a dead
        // build, and its host is an orphan.
        const r = await this.db.query(
            `SELECT setup_host_id FROM runtime.runtime_env_templates WHERE state = 'building' AND setup_host_id IS NOT NULL AND updated_at > now() - interval '3 hours'`,
        );
        return r.rows.map((x: { setup_host_id: string }) => x.setup_host_id);
    }

    async fail(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>, reason: string) {
        await this.db.query(`UPDATE runtime.runtime_env_templates SET state = 'failed', failure = $5, updated_at = now() WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint = $4 AND state = 'building'`, [t.organizationId, t.environmentId, t.poolId, t.fingerprint, reason]);
    }

    async holds(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>, failedAfter: Date) {
        const r = await this.db.query(
            `SELECT 1 FROM runtime.runtime_env_templates WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint = $4 AND (state IN ('ready', 'building') OR (state = 'failed' AND updated_at > $5)) LIMIT 1`,
            [t.organizationId, t.environmentId, t.poolId, t.fingerprint, failedAfter],
        );
        return r.rows.length > 0;
    }

    async promote(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>) {
        await this.db.query(`UPDATE runtime.runtime_env_templates SET state = 'ready', ready_at = now(), updated_at = now() WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint = $4`, [t.organizationId, t.environmentId, t.poolId, t.fingerprint]);
        const r = await this.db.query(
            `UPDATE runtime.runtime_env_templates SET state = 'replaced', replaced_at = now(), updated_at = now()
              WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint <> $4 AND state = 'ready' RETURNING snapshot_name`,
            [t.organizationId, t.environmentId, t.poolId, t.fingerprint],
        );
        return r.rows.map((x) => x.snapshot_name as string);
    }
}

/** What a Run host starts from: the environment's ready template on that pool. */
export class StoreTemplateResolver implements TemplateResolver {
    constructor(private readonly store: Pick<TemplateStore, 'readyName'>) {}

    async resolve(req: { organizationId: string; environmentId: string | null; poolId: string }) {
        return req.environmentId ? this.store.readyName(req.organizationId, req.environmentId, req.poolId) : null;
    }
}
