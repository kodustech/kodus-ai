import { join } from 'path';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';

import { DatabaseConnection } from '@libs/core/infrastructure/config/types';

import { TypeOrmCustomLogger } from './logger';

import { ENTITIES } from './entities';

@Injectable()
export class TypeORMFactory implements TypeOrmOptionsFactory {
    protected config: DatabaseConnection;

    constructor(private readonly configService: ConfigService) {
        this.config = configService.get<DatabaseConnection>('postgresDatabase');

        if (!this.config) {
            throw new Error('Database configuration not found!');
        }
    }

    createTypeOrmOptions(): TypeOrmModuleOptions {
        const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
        const isProduction = !['development', 'test'].includes(env);
        const disableSSL = process.env.API_DATABASE_DISABLE_SSL === 'true';
        const useSSL = isProduction && !disableSSL;

        // Detect component type to adjust connection pool
        const componentType = process.env.COMPONENT_TYPE || 'default';

        // Component-specific pool configuration (prioritize ENV with fallback for 300 connections plan)
        const poolConfigs = {
            webhook: {
                max: parseInt(process.env.DB_POOL_MAX_WEBHOOK || '30', 10),
                min: 2,
            },
            api: {
                max: parseInt(process.env.DB_POOL_MAX_API || '30', 10),
                min: 2,
            },
            worker: {
                max: parseInt(process.env.DB_POOL_MAX_WORKER || '60', 10),
                min: 5,
            },
            default: { max: 20, min: 1 },
        };
        const poolConfig = poolConfigs[componentType] || poolConfigs.default;

        // When the URL already declares SSL behavior via ?sslmode=, defer to
        // the driver. Forcing ssl=true here breaks setups where pgbouncer /
        // a TCP proxy in front of Postgres only speaks plain TCP.
        const urlControlsSsl =
            !!this.config.url && /[?&]sslmode=/i.test(this.config.url);

        const connectionConfig = this.config.url
            ? { url: this.config.url }
            : {
                  host: this.config.host,
                  port: this.config.port,
                  username: this.config.username,
                  password: this.config.password,
                  database: this.config.database,
              };

        const optionsTypeOrm: TypeOrmModuleOptions = {
            type: 'postgres',
            ...connectionConfig,
            entities: ENTITIES,
            autoLoadEntities: false,
            cache: false,
            migrationsRun: false,
            migrations: [join(__dirname, './migrations/*{.ts,.js}')],
            migrationsTableName: 'migrations',
            synchronize: false,
            logging: !isProduction, // Can be overridden by logger
            logger: new TypeOrmCustomLogger(!isProduction),
            maxQueryExecutionTime: 3000, // Logs slow queries > 3000ms
            ...(urlControlsSsl ? {} : { ssl: useSSL }),
            extra: {
                max: poolConfig.max,
                min: poolConfig.min,
                idleTimeoutMillis: 30000,
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

        return optionsTypeOrm;
    }
}
