import { join } from 'path';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';

import { AnalyticsDatabaseConnection } from '@libs/core/infrastructure/config/types';

import { ANALYTICS_ENTITIES } from '../entities';
import { ANALYTICS_DATA_SOURCE } from '../schema.constant';

@Injectable()
export class AnalyticsTypeORMFactory implements TypeOrmOptionsFactory {
    constructor(private readonly configService: ConfigService) {}

    createTypeOrmOptions(): TypeOrmModuleOptions {
        const config = this.configService.get<AnalyticsDatabaseConnection>(
            'analyticsPostgresDatabase',
        );

        if (!config) {
            throw new Error(
                'Analytics Postgres configuration not found. Did you import analyticsPostgresConfigLoader?',
            );
        }

        // SSL is derived from the resolved host, not from NODE_ENV. Reason:
        // NODE_ENV detection is flaky in some bootstrap paths (NestJS
        // ConfigModule overrides, dev shells exporting API_NODE_ENV=development
        // globally, etc.), and getting it wrong against a remote RDS produces
        // an opaque "no pg_hba.conf entry ... no encryption" failure.
        //
        // Rule: if a dedicated analytics host is configured (i.e. anything
        // other than a loopback address), require SSL with relaxed cert
        // verification (RDS uses Amazon's own CA chain). Local Docker /
        // self-hosted sharing OLTP keep SSL off.
        // `API_DATABASE_DISABLE_SSL=true` remains an explicit override.
        const isLoopback = ['localhost', '127.0.0.1', '::1', ''].includes(
            config.host ?? '',
        );
        const disableSSL = process.env.API_DATABASE_DISABLE_SSL === 'true';
        const useSSL = !isLoopback && !disableSSL;
        const poolMax = parseInt(
            process.env.ANALYTICS_PG_POOL_MAX ?? '5',
            10,
        );

        return {
            name: ANALYTICS_DATA_SOURCE,
            type: 'postgres',
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            database: config.database,
            schema: config.schema,
            entities: ANALYTICS_ENTITIES,
            autoLoadEntities: false,
            cache: false,
            synchronize: false,
            migrationsRun: false,
            migrations: [join(__dirname, '../migrations/*{.ts,.js}')],
            migrationsTableName: 'migrations',
            logging: isLoopback,
            ssl: useSSL,
            extra: {
                max: poolMax,
                min: 1,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 60000,
                keepAlive: true,
                ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
            },
        };
    }
}
