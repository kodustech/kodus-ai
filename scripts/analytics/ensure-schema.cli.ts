import 'dotenv/config';

import { Client } from 'pg';

import { analyticsPostgresConfigLoader } from '@libs/core/infrastructure/config/loaders/analytics-postgres.config.loader';

/**
 * Bootstraps the `analytics` schema (or whatever ANALYTICS_PG_DB_SCHEMA
 * resolves to) before TypeORM migrations run.
 *
 * Why this exists: TypeORM tries to create its `migrations` tracking
 * table inside the configured schema BEFORE running any migrations. If
 * the schema doesn't exist yet, it dies with `schema "analytics" does
 * not exist`. The init SQL handles the fresh-volume case; this CLI
 * handles existing volumes (dev/CI) and is idempotent.
 *
 * Used by both `dev-entrypoint.sh` and `prod-entrypoint.sh` right
 * before the analytics migration step.
 */
async function main() {
    const config = analyticsPostgresConfigLoader();
    const schema = config.schema;
    if (!schema) {
        // eslint-disable-next-line no-console
        console.log('[ensure-schema] no schema configured, skipping');
        return;
    }

    // Mirror the SSL semantics of `analyticsDataSourceOptions` in
    // `libs/ee/analytics-warehouse/infrastructure/ormconfig.ts`: SSL on for
    // hosted environments unless explicitly disabled. RDS requires SSL via
    // pg_hba.conf and its cert chain is Amazon-specific, so verification
    // is relaxed (matches TypeORM's `extra.ssl`).
    const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
    const useSSL =
        !['development', 'test'].includes(env ?? '') &&
        process.env.API_DATABASE_DISABLE_SSL !== 'true';

    const client = new Client({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database,
        ssl: useSSL ? { rejectUnauthorized: false } : false,
    });

    try {
        await client.connect();
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        // eslint-disable-next-line no-console
        console.log(`[ensure-schema] schema "${schema}" ready`);
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[ensure-schema] failed:', err);
    process.exit(1);
});
