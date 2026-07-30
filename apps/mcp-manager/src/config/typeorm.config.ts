import * as dotenv from 'dotenv';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';

import { MCPConnectionEntity } from '../modules/mcp/entities/mcp-connection.entity';
import { MCPIntegrationEntity } from '../modules/integrations/entities/mcp-integration.entity';
import { MCPIntegrationOAuthEntity } from '../modules/integrations/entities/mcp-integration-oauth.entity';

// Cascade: .env.local (per-dev) wins, .env (team baseline) fills the rest.
dotenv.config({ path: '.env.local' });
dotenv.config();

const requiredEnvVars = [
    'API_PG_DB_HOST',
    'API_PG_DB_PORT',
    'API_PG_DB_USERNAME',
    'API_PG_DB_PASSWORD',
    'API_PG_DB_DATABASE',
];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`Required environment variable not found: ${envVar}`);
    }
}

const isProduction =
    process.env.API_MCP_MANAGER_NODE_ENV === 'production' ||
    process.env.API_MCP_MANAGER_DATABASE_ENV === 'production';
const disableSSL = process.env.API_DATABASE_DISABLE_SSL === 'true';

const useSSL = isProduction && !disableSSL;

const sslConfig = useSSL ? { rejectUnauthorized: false } : false;

const dataSourceConfig: DataSourceOptions = {
    type: 'postgres',
    host: process.env.API_PG_DB_HOST,
    port: parseInt(process.env.API_PG_DB_PORT),
    username: process.env.API_PG_DB_USERNAME,
    password: process.env.API_PG_DB_PASSWORD,
    database: process.env.API_PG_DB_DATABASE,
    schema: 'mcp-manager',
    // Explicit entity classes — globs (`__dirname + '/../**/*.entity'`) do
    // not resolve at runtime under the webpack-bundled app build (entities
    // are inlined into `dist/.../main.js`, no individual files exist on
    // disk). The CLI migration runner uses ts-node against source files, so
    // it works either way; this list keeps both paths in sync.
    entities: [
        MCPConnectionEntity,
        MCPIntegrationEntity,
        MCPIntegrationOAuthEntity,
    ],
    migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
    migrationsTableName: 'migrations',
    synchronize: false,
    ssl: sslConfig,
    logging: isProduction ? ['error', 'warn'] : ['query', 'error', 'warn'],
    extra: {
        max: isProduction ? 20 : 10,
        min: isProduction ? 5 : 2,
        idleTimeoutMillis: isProduction ? 30000 : 10000,
    },
};

export const getTypeOrmConfig = (): TypeOrmModuleOptions => dataSourceConfig;

export default new DataSource(dataSourceConfig);
