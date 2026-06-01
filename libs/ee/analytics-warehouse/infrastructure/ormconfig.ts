import 'dotenv/config';
import { join } from 'path';

import { DataSource, DataSourceOptions } from 'typeorm';

import { ANALYTICS_ENTITIES } from '../entities';
import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * Standalone DataSource for the cockpit analytics warehouse.
 *
 * Cloud: points to a dedicated Postgres instance (ANALYTICS_PG_DB_HOST set)
 * to preserve blast-radius separation from the OLTP primary — same property
 * the current BigQuery setup gives us.
 *
 * Self-hosted: falls back to the main API Postgres, but writes to the
 * `analytics` schema so cockpit reads can never see OLTP tables.
 *
 * Used by the TypeORM CLI (migration:generate, migration:run) and by the
 * Nest `AnalyticsWarehouseModule` at app startup.
 */

// SSL is derived from the resolved host (matches AnalyticsTypeORMFactory).
// NODE_ENV-based detection is unreliable across bootstrap paths; deciding
// from the host removes that fragility.
const _resolvedHostForSSL =
    process.env.ANALYTICS_PG_DB_HOST ??
    process.env.API_PG_ANALYTICS_HOST ??
    process.env.API_PG_DB_HOST ??
    'localhost';
const _isLoopback = ['localhost', '127.0.0.1', '::1', ''].includes(
    _resolvedHostForSSL,
);
const disableSSL = process.env.API_DATABASE_DISABLE_SSL === 'true';
const useSSL = !_isLoopback && !disableSSL;

// Var lookup chain: ANALYTICS_PG_DB_* (legacy) → API_PG_ANALYTICS_* (current
// prod convention, matches the API_PG_* / API_MG_* prefix style) → API_PG_DB_*
// (self-hosted reuse of OLTP). First defined value wins.
const host =
    process.env.ANALYTICS_PG_DB_HOST ??
    process.env.API_PG_ANALYTICS_HOST ??
    process.env.API_PG_DB_HOST ??
    'localhost';

const port = parseInt(
    process.env.ANALYTICS_PG_DB_PORT ??
        process.env.API_PG_ANALYTICS_PORT ??
        process.env.API_PG_DB_PORT ??
        '5432',
    10,
);

export const analyticsDataSourceOptions: DataSourceOptions = {
    name: 'analytics',
    type: 'postgres',
    host,
    port,
    username:
        process.env.ANALYTICS_PG_DB_USERNAME ??
        process.env.API_PG_ANALYTICS_USERNAME ??
        process.env.API_PG_DB_USERNAME,
    password:
        process.env.ANALYTICS_PG_DB_PASSWORD ??
        process.env.API_PG_ANALYTICS_PASSWORD ??
        process.env.API_PG_DB_PASSWORD,
    database:
        process.env.ANALYTICS_PG_DB_DATABASE ??
        process.env.API_PG_ANALYTICS_DATABASE ??
        process.env.API_PG_DB_DATABASE,
    schema:
        process.env.ANALYTICS_PG_DB_SCHEMA ??
        process.env.API_PG_ANALYTICS_SCHEMA ??
        ANALYTICS_SCHEMA,
    logging: false,
    synchronize: false,
    cache: false,
    migrationsRun: false,
    migrationsTransactionMode: 'each',
    migrationsTableName: 'migrations',
    entities: ANALYTICS_ENTITIES,
    migrations: [join(__dirname, '../migrations/*{.ts,.js}')],
    ssl: useSSL,
    extra: {
        max: 5,
        min: 1,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 60000,
        keepAlive: true,
        ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
    },
};

export const analyticsDataSource = new DataSource(analyticsDataSourceOptions);
