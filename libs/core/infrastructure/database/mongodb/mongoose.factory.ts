import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    MongooseModuleOptions,
    MongooseOptionsFactory,
} from '@nestjs/mongoose';
import { ConnectionString } from 'connection-string';
import mongoose from 'mongoose';

import { DatabaseConnection } from '@libs/core/infrastructure/config/types';

import { MongooseConnectionFactory } from './mongoose-connection.factory';

@Injectable()
export class MongooseFactory implements MongooseOptionsFactory {
    protected config: DatabaseConnection;

    constructor(private readonly configService: ConfigService) {
        this.config = configService.get<DatabaseConnection>('mongoDatabase');
    }

    public createMongooseOptions(): MongooseModuleOptions {
        const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
        const isProduction = !['development', 'test'].includes(env ?? '');

        if (!isProduction) {
            mongoose.set('debug', true);
        }

        let uri: string;

        if (this.config.url) {
            uri = this.config.url;
        } else {
            uri = new ConnectionString('', {
                user: this.config.username,
                password: this.config.password,
                protocol: this.config.port ? 'mongodb' : 'mongodb+srv',
                hosts: [{ name: this.config.host, port: this.config.port }],
            }).toString();

            const shouldAppendClusterConfig =
                isProduction && !!process.env.API_MG_DB_PRODUCTION_CONFIG;

            if (shouldAppendClusterConfig) {
                uri = `${uri}/${process.env.API_MG_DB_PRODUCTION_CONFIG}`;
            }
        }

        const { createForInstance } = MongooseConnectionFactory;

        // Detect component type to adjust connection pool
        const componentType = process.env.COMPONENT_TYPE || 'default';

        // Pool configuration per component (300 connections prod plan)
        // Pool configuration per component (prioritize ENV with safe fallbacks)
        const poolConfigs = {
            webhook: {
                max: parseInt(process.env.MG_POOL_MAX_WEBHOOK || '30', 10),
                min: 2,
            },
            api: {
                max: parseInt(process.env.MG_POOL_MAX_API || '30', 10),
                min: 5,
            },
            worker: {
                max: parseInt(process.env.MG_POOL_MAX_WORKER || '60', 10),
                min: 5,
            },
            default: { max: 50, min: 5 },
        };
        const poolConfig = poolConfigs[componentType] || poolConfigs.default;

        // maxIdleTimeMS: Time a connection can remain idle before being removed
        // PERF: Increased from 50s to 5min to reduce connection churn
        // The connection_pool.js ensureMinPoolSize was consuming ~20% CPU
        // due to frequent connection destruction/recreation cycles
        const maxIdleTimeMS = this.configService.get<number>(
            'MG_MAX_IDLE_TIME_MS',
            300000,
        );

        return {
            uri: uri,
            dbName: this.config.database,
            connectionFactory: createForInstance,
            minPoolSize: poolConfig.min,
            maxPoolSize: poolConfig.max,
            maxIdleTimeMS,
        };
    }
}
