import { Injectable } from '@nestjs/common';
import {
    TypeOrmHealthIndicator,
    MongooseHealthIndicator,
} from '@nestjs/terminus';

@Injectable()
export class DatabaseHealthIndicator {
    constructor(
        private readonly typeOrmHealthIndicator: TypeOrmHealthIndicator,
        private readonly mongooseHealthIndicator: MongooseHealthIndicator,
    ) {}

    /**
     * Postgres-only probe, bounded by a short timeout.
     *
     * Exists for load-balancer probes that must notice a starved connection
     * pool. A pool with every slot pinned (e.g. by long-held advisory locks)
     * still passes a process-liveness check — the event loop is fine, it is
     * the pool that is unusable — so the process keeps serving requests that
     * all stall for `connectionTimeoutMillis`. Acquiring a real connection is
     * the only probe that observes that state.
     *
     * Deliberately does NOT check Mongo: this probe can gate traffic, and a
     * Mongo blip must not take the API out of rotation.
     */
    async isPostgresHealthy(timeoutMs = 3000) {
        try {
            const postgres = await this.typeOrmHealthIndicator.pingCheck(
                'postgres',
                { timeout: timeoutMs },
            );
            return {
                status: postgres.postgres.status === 'up' ? 'up' : 'down',
                postgres: postgres.postgres,
            };
        } catch (error) {
            return {
                status: 'down' as const,
                postgres: {
                    status: 'down',
                    message: error instanceof Error ? error.message : 'unknown',
                },
            };
        }
    }

    async isDatabaseHealthy() {
        const postgres = await this.typeOrmHealthIndicator.pingCheck(
            'postgres',
            {
                timeout: 5000,
            },
        );
        const mongo = await this.mongooseHealthIndicator.pingCheck('mongodb', {
            timeout: 5000,
        });

        return {
            database: {
                status:
                    postgres.postgres.status === 'up' &&
                    mongo.mongodb.status === 'up'
                        ? 'up'
                        : 'down',
                postgres: postgres.postgres,
                mongodb: mongo.mongodb,
            },
        };
    }
}
