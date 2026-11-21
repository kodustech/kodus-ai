import type { RuntimeOrganizationPurgeStore } from '../domain/organization-purge';
import { orgCounterPrefixes, RUNTIME_LLM_BUDGET_TABLE, RUNTIME_LLM_RESERVATIONS_TABLE, runCounterKey } from './typeorm-llm-budget.store';
import { RUNTIME_SECRET_AUDIT_TABLE, RUNTIME_SECRETS_TABLE } from './typeorm-runtime-secrets.store';
import type { Sql } from './typeorm-sql';

/** Rows one statement removes at most: short transactions, never a long lock on the writers. */
const BATCH = 5_000;

/**
 * The product Postgres tables of the Runtime that carry `organization_id` (the entities in `runtime-product.models.ts`
 * and `runtime-external-finding.models.ts`, and the tables the product stores moved here), each emptied by that
 * column. A new Runtime table of the product goes here; the integration spec fails until it does.
 */
export const RUNTIME_PRODUCT_ORGANIZATION_TABLES: readonly string[] = [
    'runtime_environment_repositories',
    'runtime_environments',
    'runtime_settings',
    'runtime_repository_settings',
    'runtime_finding_feedback',
    'runtime_finding_intent',
    'runtime_external_submissions',
    'runtime_external_message_keys',
    RUNTIME_LLM_RESERVATIONS_TABLE,
    'runtime_env_audit',
    'runtime_publications',
    'runtime_pr_comments',
    'runtime_pr_checks',
    'runtime_reconciled_heads',
    'runtime_kept_checks',
    'runtime_run_targets',
];

/**
 * Every query names the org. The LLM budget counters are keyed, not columned: the per-PR and per-day counters carry
 * the org id in their key, and a Run's counter is found through the org's run targets (read before they go).
 */
export class TypeOrmRuntimeOrganizationPurgeStore implements RuntimeOrganizationPurgeStore {
    constructor(private readonly sql: Sql) {}

    async secretIds(organizationId: string) {
        const { rows } = await this.sql.query(`SELECT secret_id FROM ${RUNTIME_SECRETS_TABLE} WHERE organization_id = $1 ORDER BY secret_id`, [organizationId]);
        return rows.map((r) => String(r.secret_id));
    }

    async purgeOrganization(organizationId: string, opts: { keepSecretIds?: string[] } = {}) {
        const removed: Record<string, number> = {};
        const sweep = async (table: string, where: string, params: unknown[]) => {
            const n = await this.removeWhere(table, where, params);
            if (n) removed[table] = (removed[table] ?? 0) + n;
        };
        const keep = opts.keepSecretIds ?? [];

        // The counters keyed by the org's Runs, before the run targets that name them go.
        const runIds = (await this.sql.query(`SELECT run_id FROM runtime_run_targets WHERE organization_id = $1`, [organizationId])).rows.map((r) => String(r.run_id));
        for (let i = 0; i < runIds.length; i += 1000) {
            await sweep(RUNTIME_LLM_BUDGET_TABLE, `key = ANY($1::text[])`, [runIds.slice(i, i + 1000).map(runCounterKey)]);
        }
        // A prefix test, so an org id with a LIKE wildcard in it cannot widen it.
        const [pullRequests, days] = orgCounterPrefixes(organizationId);
        await sweep(RUNTIME_LLM_BUDGET_TABLE, `starts_with(key, $1) OR starts_with(key, $2)`, [pullRequests, days]);

        for (const table of RUNTIME_PRODUCT_ORGANIZATION_TABLES) await sweep(table, 'organization_id = $1', [organizationId]);
        // A secret whose value is still in OpenBao keeps its row and the audit, so the purge can be run again.
        await sweep(RUNTIME_SECRETS_TABLE, 'organization_id = $1 AND secret_id <> ALL($2::text[])', [organizationId, keep]);
        if (!keep.length) await sweep(RUNTIME_SECRET_AUDIT_TABLE, 'organization_id = $1', [organizationId]);
        return removed;
    }

    private async removeWhere(table: string, where: string, params: unknown[]): Promise<number> {
        let total = 0;
        for (;;) {
            const n = (await this.sql.query(`DELETE FROM ${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${table} WHERE ${where} LIMIT $${params.length + 1}))`, [...params, BATCH])).rowCount;
            total += n;
            if (n < BATCH) return total;
        }
    }
}
