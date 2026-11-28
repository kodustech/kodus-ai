import type { Pool } from 'pg';

import type { TemplateSetupRequester } from './template-trigger';

// The fleet process holds no repository or LLM credentials, so it cannot produce the setup command itself
// (docs/runtime/host-providers.md §8.2). It records the key it chose on the template's `building` row; the product
// reads pending rows (runtime_env_templates with a setup_key and no setup record for it) and issues the command.

export class PgTemplateSetupRequester implements TemplateSetupRequester {
    constructor(private readonly db: Pick<Pool, 'query'>) {}

    async request(req: { organizationId: string; environmentId: string; poolId: string; fingerprint: string; key: string; boundKey: string }) {
        const r = await this.db.query(
            `UPDATE runtime.runtime_env_templates SET setup_key = $5, setup_requested_at = now(), updated_at = now()
              WHERE org_id = $1 AND environment_id = $2 AND pool_id = $3 AND fingerprint = $4 AND state = 'building'`,
            [req.organizationId, req.environmentId, req.poolId, req.fingerprint, req.key],
        );
        // No building row: the build ended or was never begun; asking for a setup nobody waits for would only burn tokens.
        if (!r.rowCount) throw new Error('template_row_not_building');
    }
}
