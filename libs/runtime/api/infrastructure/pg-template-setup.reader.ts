import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { PendingTemplateSetup, RuntimeTemplateSetupReader } from '../domain/ports';

/**
 * The template builds waiting for their setup command (runtime-fleet writes setup_key on the `building` row): asked in
 * the last hour, and the environment's setup record does not hold that key yet. Read-only, through RuntimeReadDb.
 */
export class PgTemplateSetupReader implements RuntimeTemplateSetupReader {
    constructor(private readonly db: SqlQuery) {}

    async pending(limit: number): Promise<PendingTemplateSetup[]> {
        const res = await this.db.query(
            `SELECT t.org_id, t.environment_id, t.setup_key
               FROM runtime.runtime_env_templates t
              WHERE t.state = 'building' AND t.setup_key IS NOT NULL AND t.setup_requested_at > now() - interval '1 hour'
                AND NOT EXISTS (SELECT 1 FROM runtime.runtime_environment_setups s WHERE s.organization_id = t.org_id AND s.environment_id = t.environment_id AND s.setup_key = t.setup_key)
              ORDER BY t.setup_requested_at
              LIMIT $1`,
            [limit],
        );
        return (res.rows as Array<{ org_id: string; environment_id: string; setup_key: string }>).map((r) => ({ organizationId: r.org_id, environmentId: r.environment_id, key: r.setup_key }));
    }
}
