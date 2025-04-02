import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';
import { join } from 'path';
import { DatabaseConnection, OptionsOrm } from '@/config/types';

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

        const optionsDataBaseProd = {
            ssl: true,
            extra: {
                ssl: {
                    rejectUnauthorized: false,
                },
            },
        };

        const optionsTypeOrm: OptionsOrm = {
            type: 'postgres',
            host: this.config.host,
            port: this.config.port,
            username: this.config.username,
            password: this.config.password,
            database: this.config.database,
            entities: [
                join(
                    __dirname,
                    '../../../core/infrastructure/adapters/repositories/typeorm/schema/*.model{.ts,.js}',
                ),
            ],
            autoLoadEntities: true,
            cache: false,
            migrationsRun: false,
            migrations: [join(__dirname, './migrations/*{.ts,.js}')],
            migrationsTableName: 'migrations',
            synchronize: false,
            logging: false,
            logger: 'file',
            // Add cache configurations, if necessary
            // cache: {
            //     duration: 30000, // 1 minute
            // },

            // Additional connection pool configurations
            extra: {
                max: 40, // Maximum number of connections in the pool
                min: 1, // Minimum number of connections in the pool
                idleTimeoutMillis: 10000, // Time in milliseconds for an idle connection to be released
            },
        };

        const mergedConfig = {
            ...optionsTypeOrm,
            ...(['development', 'test'].includes(env)
                ? {}
                : optionsDataBaseProd),
        };

        return mergedConfig;
    }
}
