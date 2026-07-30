import { registerAs } from '@nestjs/config';

import { AnalyticsDatabaseConnection } from '@libs/core/infrastructure/config/types';

/**
 * Config for the analytics Postgres DataSource (cockpit warehouse).
 *
 * Cloud: dedicated Postgres instance (ANALYTICS_PG_DB_HOST set) to preserve
 * blast-radius separation from the OLTP primary (same property BigQuery gives
 * us today, where it lives in a separate GCP project).
 *
 * Self-hosted: ANALYTICS_PG_DB_HOST unset → reuse the main API Postgres, but
 * still scoped to the `analytics` schema so reads/writes can never reach
 * OLTP tables accidentally.
 */
// Read an env var treating an empty / whitespace-only string as UNSET.
// Critical for the fallback chains below: docker-compose writes unset vars
// as empty strings (`${VAR:-}`) and the deploy docs tell self-hosted operators
// to "leave ANALYTICS_PG_DB_HOST empty". With a plain `??` chain an empty
// string is a defined value, so it wins over the API_PG_DB_* fallback and the
// host resolves to '' → the driver connects to 127.0.0.1 → ECONNREFUSED and the
// analytics worker crash-loops. Coercing '' → undefined makes the chain behave
// the way both the docs and the `??` reading intend.
const envOrUndef = (key: string): string | undefined => {
    const v = process.env[key];
    return v !== undefined && v.trim() !== '' ? v : undefined;
};

export const analyticsPostgresConfigLoader = registerAs(
    'analyticsPostgresDatabase',
    (): AnalyticsDatabaseConnection => {
        const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
        const isHosted = ['homolog', 'production'].includes(env ?? '');

        // Var lookup chain: ANALYTICS_PG_DB_* (legacy) → API_PG_ANALYTICS_*
        // (current prod convention, matches API_PG_* / API_MG_* style) →
        // API_PG_DB_* (self-hosted reuse of OLTP). First NON-EMPTY value wins.
        const host =
            envOrUndef('ANALYTICS_PG_DB_HOST') ??
            envOrUndef('API_PG_ANALYTICS_HOST') ??
            (isHosted
                ? envOrUndef('API_PG_DB_HOST')
                : (envOrUndef('API_PG_DB_HOST') ?? 'localhost'));

        const port = parseInt(
            envOrUndef('ANALYTICS_PG_DB_PORT') ??
                envOrUndef('API_PG_ANALYTICS_PORT') ??
                envOrUndef('API_PG_DB_PORT') ??
                '5432',
            10,
        );

        return {
            host,
            port,
            username:
                envOrUndef('ANALYTICS_PG_DB_USERNAME') ??
                envOrUndef('API_PG_ANALYTICS_USERNAME') ??
                envOrUndef('API_PG_DB_USERNAME'),
            password:
                envOrUndef('ANALYTICS_PG_DB_PASSWORD') ??
                envOrUndef('API_PG_ANALYTICS_PASSWORD') ??
                envOrUndef('API_PG_DB_PASSWORD'),
            database:
                envOrUndef('ANALYTICS_PG_DB_DATABASE') ??
                envOrUndef('API_PG_ANALYTICS_DATABASE') ??
                envOrUndef('API_PG_DB_DATABASE'),
            schema:
                envOrUndef('ANALYTICS_PG_DB_SCHEMA') ??
                envOrUndef('API_PG_ANALYTICS_SCHEMA') ??
                'analytics',
        };
    },
);
