import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    MongooseModuleOptions,
    MongooseOptionsFactory,
} from '@nestjs/mongoose';
import { ConnectionString } from 'connection-string';
import mongoose from 'mongoose';

import { DatabaseConnection } from '@libs/core/infrastructure/config/types';
import { mongoAppName } from '@libs/core/infrastructure/database/mongo/mongo-app-name';

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
            mongoose.set('debug', false);
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
        // `min` holds open per replica-set member, not per cluster: with three
        // members a process keeps 3x min connections even when it reads only
        // from the primary. API and webhook tasks are many and mostly idle
        // between requests, so they keep one; workers keep more warm.
        // A blank, unparseable or below-minimum value falls back to the
        // default: `0` would disable a pool cap or a timeout, and NaN would
        // reach the driver as an invalid option. Only a pool's `min` may be 0.
        const envInt = (key: string, fallback: number, minimum = 1) => {
            const parsed = Number.parseInt(process.env[key] ?? '', 10);
            return Number.isFinite(parsed) && parsed >= minimum
                ? parsed
                : fallback;
        };
        const poolConfigs = {
            webhook: {
                max: envInt('MG_POOL_MAX_WEBHOOK', 30),
                min: envInt('MG_POOL_MIN_WEBHOOK', 1, 0),
            },
            api: {
                max: envInt('MG_POOL_MAX_API', 30),
                min: envInt('MG_POOL_MIN_API', 1, 0),
            },
            worker: {
                max: envInt('MG_POOL_MAX_WORKER', 60),
                min: envInt('MG_POOL_MIN_WORKER', 5, 0),
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
            // Fail a request that cannot get a connection instead of queueing
            // it behind a saturated pool forever, and give up on a cluster
            // with no reachable primary after an election's worth of time.
            serverSelectionTimeoutMS: envInt(
                'MG_SERVER_SELECTION_TIMEOUT_MS',
                15_000,
            ),
            waitQueueTimeoutMS: envInt('MG_WAIT_QUEUE_TIMEOUT_MS', 30_000),
            // Builds every schema index on boot unless turned off
            // (MONGO_AUTO_INDEX=false): on a large collection a missing index
            // becomes a build on the primary started by each deploy. Nothing
            // else builds the schema indexes of Mongoose models (no migration
            // does), so before turning it off check every declared index exists
            // in production, and build any new one by hand.
            autoIndex: process.env.MONGO_AUTO_INDEX !== 'false',
            appName: mongoAppName(),
        };
    }
}
