import 'dotenv/config';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { SeederOptions } from 'typeorm-extension';
import MainSeeder from './seed/main.seeder';

const optionsDataBaseProd = {
    ssl: true,
    extra: {
        ssl: {
            rejectUnauthorized: false,
        },
    },
};

const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;

const optionsDataBase: DataSourceOptions = {
    type: 'postgres',
    host: ['development', 'test'].includes(env)
        ? 'localhost'
        : process.env.API_PG_DB_HOST,
    port: parseInt(process.env.API_PG_DB_PORT!, 10),
    username: process.env.API_PG_DB_USERNAME,
    password: process.env.API_PG_DB_PASSWORD,
    database: process.env.API_PG_DB_DATABASE,
    logging: false,
    logger: 'file',
    synchronize: false,
    cache: false,
    migrationsRun: false,
    entities: [
        join(
            __dirname,
            '../../../core/infrastructure/adapters/repositories/typeorm/schema/*.model{.ts,.js}',
        ),
    ],
    migrations: [join(__dirname, './migrations/*{.ts,.js}')],
};

const mergedConfig = {
    ...optionsDataBase,
    ...(['development', 'test'].includes(env)
        ? {}
        : optionsDataBaseProd),
};

const optionsSeeder: SeederOptions = {
    factories: [],
    seeds: [MainSeeder],
};

const AppDataSource = new DataSource({ ...mergedConfig, ...optionsSeeder });

export const dataSourceInstance = AppDataSource;
