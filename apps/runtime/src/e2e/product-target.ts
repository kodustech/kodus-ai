import { Pool, type PoolConfig } from 'pg';

import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { runTargetOf, type RunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { PgRunTargetStore } from '@libs/runtime-publish/infrastructure/pg-run-target.store';
import type { RuntimeRunRequested } from '@libs/runtime/run';

// The e2e scripts publish a RuntimeRunRequested straight to the broker,
// standing in for the product's PR trigger. The product records the Run's
// publish target in its own Postgres before the outbox row (RuntimeRunEnqueuer),
// and "Run again" only trusts that record, so the e2e writes it the same way
// with the product's connection. Nothing the Runtime holds can write it.

/** The product Postgres from E2E_PRODUCT_DATABASE_URL or E2E_PRODUCT_PG_{HOST,PORT,USER,PASSWORD,DATABASE}. */
export function productPgConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig | null {
    if (env.E2E_PRODUCT_DATABASE_URL) return { connectionString: env.E2E_PRODUCT_DATABASE_URL, max: 1 };
    if (!env.E2E_PRODUCT_PG_USER || !env.E2E_PRODUCT_PG_DATABASE) return null;
    return {
        host: env.E2E_PRODUCT_PG_HOST || 'db_postgres',
        port: Number(env.E2E_PRODUCT_PG_PORT || 5432),
        user: env.E2E_PRODUCT_PG_USER,
        password: env.E2E_PRODUCT_PG_PASSWORD,
        database: env.E2E_PRODUCT_PG_DATABASE,
        max: 1,
    };
}

/** Records the target of a Run this e2e is about to publish; `skipped` without a product connection. */
export async function recordProductTarget(
    req: RuntimeRunRequested,
    opts: { env?: NodeJS.ProcessEnv; store?: RunTargetStore } = {},
): Promise<'recorded' | 'skipped'> {
    const env = opts.env ?? process.env;
    const platform = (env.E2E_PLATFORM || 'GITHUB') as PlatformType;
    if (opts.store) {
        await opts.store.record(runTargetOf(req, platform));
        return 'recorded';
    }
    const config = productPgConfig(env);
    if (!config) return 'skipped';
    const pool = new Pool(config);
    try {
        await new PgRunTargetStore(pool).record(runTargetOf(req, platform));
        return 'recorded';
    } finally {
        await pool.end().catch(() => undefined);
    }
}
