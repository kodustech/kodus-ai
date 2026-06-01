import 'dotenv/config';

import { Client } from 'pg';

/**
 * Bootstraps the `mcp-manager` Postgres schema (or whatever
 * API_MCP_MANAGER_PG_DB_SCHEMA resolves to) before TypeORM runs the
 * mcp-manager migrations.
 *
 * Why this exists: TypeORM tries to create its `migrations` tracking
 * table inside the configured schema BEFORE running any migrations.
 * If the schema doesn't exist yet, the run dies with
 * `schema "mcp-manager" does not exist`. Idempotent.
 *
 * Used by dev-entrypoint.sh and prod-entrypoint.sh right before the
 * mcp-manager migration step.
 */
async function main() {
    const schema = process.env.API_MCP_MANAGER_PG_DB_SCHEMA || 'mcp-manager';

    const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
    const useSSL =
        !['development', 'test'].includes(env ?? '') &&
        process.env.API_DATABASE_DISABLE_SSL !== 'true';

    const client = new Client({
        host: process.env.API_PG_DB_HOST,
        port: process.env.API_PG_DB_PORT
            ? parseInt(process.env.API_PG_DB_PORT, 10)
            : 5432,
        user: process.env.API_PG_DB_USERNAME,
        password: process.env.API_PG_DB_PASSWORD,
        database: process.env.API_PG_DB_DATABASE,
        ssl: useSSL ? { rejectUnauthorized: false } : false,
    });

    await client.connect();
    try {
        // Schema names with hyphens (like "mcp-manager") MUST be quoted.
        // `pg-format`-style escaping by hand: replace " with "" then wrap.
        const quoted = `"${schema.replace(/"/g, '""')}"`;
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted};`);
        // eslint-disable-next-line no-console
        console.log(`[mcp-manager:ensure-schema] schema "${schema}" ready`);
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[mcp-manager:ensure-schema] failed:', err);
    process.exit(1);
});
