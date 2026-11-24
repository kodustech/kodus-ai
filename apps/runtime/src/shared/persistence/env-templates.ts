import type { Pool } from 'pg';

/**
 * The environment templates the fleet keeps (`runtime_env_templates`), read by the worker: a suite run starts the hosts of
 * its main side from a ready template, and without one it asks for a build and leaves main out (docs/runtime/e2e-suites.md 9.5).
 * The fleet is the only writer.
 */
export class PgEnvTemplates {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async hasReady(organizationId: string, environmentId: string): Promise<boolean> {
        const r = await this.pool.query(`SELECT 1 FROM runtime.runtime_env_templates WHERE org_id = $1 AND environment_id = $2 AND state = 'ready' LIMIT 1`, [organizationId, environmentId]);
        return (r.rowCount ?? 0) > 0;
    }
}
