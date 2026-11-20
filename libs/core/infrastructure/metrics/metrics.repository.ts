import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
    ANALYTICS_QUERY_READ,
    ANALYTICS_READ_PREFERENCE,
} from '@libs/core/infrastructure/database/mongo/read-preference';
import { MONGO_QUERY_MAX_TIME_MS } from '@libs/core/infrastructure/database/mongo/query-timeout';
import {
    HttpCountByComponent,
    IMetricsRepository,
    StageDuration,
} from '@libs/core/metrics/domain/contracts/metrics.repository.contract';

import { MetricsEventModel } from './schemas/metrics-event.schema';

/**
 * Every read here is analytics: it goes to the analytics member (see
 * read-preference.ts) and is bounded by MONGO_QUERY_MAX_TIME_MS.
 */
@Injectable()
export class MetricsRepository implements IMetricsRepository {
    constructor(
        @InjectModel(MetricsEventModel.name)
        private readonly metricsModel: Model<MetricsEventModel>,
    ) {}

    async sumHttpCountsByComponent(
        since: Date,
    ): Promise<HttpCountByComponent[]> {
        const rows = await this.metricsModel
            .aggregate<{
                _id: { component: string; name: string };
                count: number;
            }>([
                {
                    $match: {
                        name: {
                            $in: ['http_errors_total', 'http_request_total'],
                        },
                        recordedAt: { $gte: since },
                    },
                },
                {
                    $group: {
                        _id: {
                            component: {
                                $ifNull: ['$labels.component', 'unknown'],
                            },
                            name: '$name',
                        },
                        count: { $sum: '$value' },
                    },
                },
            ])
            .read(ANALYTICS_READ_PREFERENCE)
            .option({ maxTimeMS: MONGO_QUERY_MAX_TIME_MS });
        return rows.map((row) => ({
            component: row._id.component,
            name: row._id.name,
            count: row.count,
        }));
    }

    async findReviewDurations(since: Date): Promise<number[]> {
        const rows = await this.metricsModel
            .find(
                {
                    name: 'code_review_duration_ms',
                    recordedAt: { $gte: since },
                },
                { value: 1 },
            )
            .read(ANALYTICS_QUERY_READ)
            .maxTimeMS(MONGO_QUERY_MAX_TIME_MS)
            .lean();
        return rows.map((row) => row.value);
    }

    countReviewErrors(since: Date): Promise<number> {
        return this.metricsModel
            .countDocuments({
                name: 'code_review_errors_total',
                recordedAt: { $gte: since },
            })
            .read(ANALYTICS_QUERY_READ)
            .maxTimeMS(MONGO_QUERY_MAX_TIME_MS)
            .exec();
    }

    async averageStageDurations(since: Date): Promise<StageDuration[]> {
        const rows = await this.metricsModel
            .aggregate<{
                _id: { pipeline?: string; stage?: string };
                avgDurationMs: number;
                count: number;
            }>([
                {
                    $match: {
                        name: 'pipeline_stage_duration_ms',
                        recordedAt: { $gte: since },
                    },
                },
                {
                    $group: {
                        _id: {
                            pipeline: '$labels.pipeline',
                            stage: '$labels.stage',
                        },
                        avgDurationMs: { $avg: '$value' },
                        count: { $sum: 1 },
                    },
                },
                {
                    $sort: {
                        '_id.pipeline': 1 as const,
                        'avgDurationMs': -1 as const,
                    },
                },
            ])
            .read(ANALYTICS_READ_PREFERENCE)
            .option({ maxTimeMS: MONGO_QUERY_MAX_TIME_MS });
        return rows.map((row) => ({
            pipeline: row._id.pipeline,
            stage: row._id.stage,
            avgDurationMs: row.avgDurationMs,
            count: row.count,
        }));
    }
}
