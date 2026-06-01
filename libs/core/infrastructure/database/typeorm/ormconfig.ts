import 'dotenv/config';
import { join } from 'path';

import { DataSource, DataSourceOptions } from 'typeorm';
import { SeederOptions } from 'typeorm-extension';

import MainSeeder from './seed/main.seeder';
import { ENTITIES } from './entities';

const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
const isProduction = !['development', 'test'].includes(env);
const disableSSL = process.env.API_DATABASE_DISABLE_SSL === 'true';
const useSSL = isProduction && !disableSSL;

const connectionUrl = process.env.DATABASE_URL ?? process.env.API_PG_DB_URL;

// When the URL already declares SSL behavior via ?sslmode=, defer to the
// driver. Forcing ssl=true here breaks setups where pgbouncer / a TCP proxy
// in front of Postgres only speaks plain TCP.
const urlControlsSsl =
    !!connectionUrl && /[?&]sslmode=/i.test(connectionUrl);

const connectionConfig = connectionUrl
    ? { url: connectionUrl }
    : {
          host: process.env.API_PG_DB_HOST,
          port: parseInt(process.env.API_PG_DB_PORT!, 10),
          username: process.env.API_PG_DB_USERNAME,
          password: process.env.API_PG_DB_PASSWORD,
          database: process.env.API_PG_DB_DATABASE,
      };

const optionsDataBase: DataSourceOptions = {
    type: 'postgres',
    ...connectionConfig,
    logging: false,
    // Stream CLI logs (migrations, seeds) to stdout instead of writing
    // ./ormlogs.log — that file write breaks under restricted PSA with
    // readOnlyRootFilesystem=true, and the runtime TypeOrmFactory
    // already uses a stdout-based TypeOrmCustomLogger anyway.
    logger: 'advanced-console',
    synchronize: false,
    cache: false,
    migrationsRun: false,
    // Allow individual migrations to override transaction mode
    // Required for CREATE INDEX CONCURRENTLY (must run outside transactions)
    migrationsTransactionMode: 'each',
    entities: ENTITIES,
    migrations: [join(__dirname, './migrations/*{.ts,.js}')],
    ...(urlControlsSsl ? {} : { ssl: useSSL }),
    extra: {
        max: 10,
        min: 1,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 60000,
        keepAlive: true,
        ...(!urlControlsSsl && useSSL
            ? {
                  ssl: {
                      rejectUnauthorized: false,
                  },
              }
            : {}),
    },
};

const mergedConfig = optionsDataBase;

const optionsSeeder: SeederOptions = {
    factories: [],
    seeds: [MainSeeder],
};

const AppDataSource = new DataSource({ ...mergedConfig, ...optionsSeeder });

export const dataSourceInstance = AppDataSource;
