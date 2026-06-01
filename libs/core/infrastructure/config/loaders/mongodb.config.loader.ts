import { registerAs } from '@nestjs/config';

import { DatabaseConnection } from '@libs/core/infrastructure/config/types';

export const mongoDBConfigLoader = registerAs(
    'mongoDatabase',
    (): DatabaseConnection => {
        const connectionUrl =
            process.env.MONGODB_URI ?? process.env.API_MG_DB_URI;

        if (connectionUrl) {
            return { url: connectionUrl, database: process.env.API_MG_DB_DATABASE };
        }

        const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
        return {
            host: ['homolog', 'production'].includes(env ?? '')
                ? process.env.API_MG_DB_HOST
                : (process.env.API_MG_DB_HOST ?? 'localhost'),
            port: parseInt(process.env.API_MG_DB_PORT, 10),
            username: process.env.API_MG_DB_USERNAME,
            password: process.env.API_MG_DB_PASSWORD,
            database: process.env.API_MG_DB_DATABASE,
        };
    },
);
