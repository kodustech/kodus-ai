import { registerAs } from '@nestjs/config';
import { DatabaseConnection } from '@/config/types';

export const mongoDBConfigLoader = registerAs(
    'mongoDatabase',
    (): DatabaseConnection => ({
        host:
            process.env.API_NODE_ENV === 'test'
                ? 'localhost'
                : process.env.API_MG_DB_HOST,
        port: parseInt(process.env.API_MG_DB_PORT, 10),
        username: process.env.API_MG_DB_USERNAME,
        password: process.env.API_MG_DB_PASSWORD,
        database: process.env.API_MG_DB_DATABASE,
    }),
);
