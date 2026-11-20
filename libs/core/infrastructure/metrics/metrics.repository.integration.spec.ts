/**
 * The metrics reads against a real MongoDB, in a throwaway database.
 */
import mongoose, { Connection, Model } from 'mongoose';

import { MetricsRepository } from './metrics.repository';
import {
    MetricsEventModel,
    MetricsEventSchema,
} from './schemas/metrics-event.schema';
import { resolveMongoTestGate } from '../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'kodus_metrics_repository_it';

(gate.shouldSkip ? describe.skip : describe)(
    'MetricsRepository (real MongoDB)',
    () => {
        let connection: Connection;
        let model: Model<MetricsEventModel>;
        let repository: MetricsRepository;
        const now = Date.now();
        const since = new Date(now - 60 * 60 * 1000);
        const event = (
            name: string,
            value: number,
            labels: Record<string, string> = {},
            minutesAgo = 5,
        ) => ({
            name,
            type: 'counter',
            value,
            labels,
            recordedAt: new Date(now - minutesAgo * 60 * 1000),
        });

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
            await connection.dropDatabase();
            model = connection.model<MetricsEventModel>(
                MetricsEventModel.name,
                MetricsEventSchema,
            );
            await model.insertMany([
                event('http_request_total', 10, { component: 'api' }),
                event('http_request_total', 5, { component: 'api' }),
                event('http_errors_total', 2, { component: 'api' }),
                event('http_errors_total', 1),
                // Outside the window.
                event('http_request_total', 99, { component: 'api' }, 120),
                event('code_review_duration_ms', 300),
                event('code_review_duration_ms', 100),
                event('code_review_errors_total', 1),
                event('code_review_errors_total', 1),
                event('pipeline_stage_duration_ms', 10, {
                    pipeline: 'review',
                    stage: 'finder',
                }),
                event('pipeline_stage_duration_ms', 30, {
                    pipeline: 'review',
                    stage: 'finder',
                }),
                event('pipeline_stage_duration_ms', 5, {
                    pipeline: 'review',
                    stage: 'fetch',
                }),
            ]);
            repository = new MetricsRepository(model as any);
        }, 30_000);

        afterAll(async () => {
            await connection?.dropDatabase();
            await connection?.close();
        });

        it('sums the HTTP counters per component inside the window', async () => {
            const rows = await repository.sumHttpCountsByComponent(since);

            expect(
                rows.sort((a, b) =>
                    `${a.component}${a.name}`.localeCompare(
                        `${b.component}${b.name}`,
                    ),
                ),
            ).toEqual([
                { component: 'api', name: 'http_errors_total', count: 2 },
                { component: 'api', name: 'http_request_total', count: 15 },
                { component: 'unknown', name: 'http_errors_total', count: 1 },
            ]);
        });

        it('reads the review durations and counts the review errors', async () => {
            expect(
                (await repository.findReviewDurations(since)).sort(),
            ).toEqual([100, 300]);
            await expect(repository.countReviewErrors(since)).resolves.toBe(2);
        });

        it('averages the stage durations, slowest stage first per pipeline', async () => {
            await expect(
                repository.averageStageDurations(since),
            ).resolves.toEqual([
                {
                    pipeline: 'review',
                    stage: 'finder',
                    avgDurationMs: 20,
                    count: 2,
                },
                {
                    pipeline: 'review',
                    stage: 'fetch',
                    avgDurationMs: 5,
                    count: 1,
                },
            ]);
        });
    },
);
