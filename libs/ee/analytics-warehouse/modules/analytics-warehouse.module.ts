import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { analyticsPostgresConfigLoader } from '@libs/core/infrastructure/config/loaders/analytics-postgres.config.loader';
import {
    CodeReviewFeedbackModel,
    CodeReviewFeedbackSchema,
} from '@libs/code-review/infrastructure/adapters/repositories/schemas/mongoose/codeReviewFeedback.model';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';

import { PullRequestClassifierService } from '../classification/pull-request-classifier.service';
import { ANALYTICS_ENTITIES } from '../entities';
import { BackfillOrchestratorService } from '../ingestion/backfill-orchestrator.service';
import { FeedbackIngestionService } from '../ingestion/feedback-ingestion.service';
import { PullRequestIngestionService } from '../ingestion/pull-request-ingestion.service';
import { ReviewOperationalIngestionService } from '../ingestion/review-operational-ingestion.service';
import { AnalyticsTypeORMFactory } from '../infrastructure/typeORM.factory';
import { ANALYTICS_DATA_SOURCE } from '../schema.constant';

/**
 * Second TypeORM connection, separate from the main `default` DataSource,
 * pointing at the cockpit warehouse Postgres (dedicated instance on cloud,
 * same instance + `analytics` schema on self-hosted).
 *
 * Consumers use `@InjectRepository(Entity, ANALYTICS_DATA_SOURCE)` to reach
 * these entities — they will NOT be resolved from the default connection.
 *
 * Also exposes the ingestion service so both the worker cron and the
 * backfill CLI can drive a run from the same code path.
 */
@Module({})
export class AnalyticsWarehouseModule {
    static forRoot(): DynamicModule {
        return {
            module: AnalyticsWarehouseModule,
            imports: [
                TypeOrmModule.forRootAsync({
                    name: ANALYTICS_DATA_SOURCE,
                    imports: [
                        ConfigModule.forFeature(analyticsPostgresConfigLoader),
                    ],
                    inject: [ConfigService],
                    useFactory: (configService: ConfigService) =>
                        new AnalyticsTypeORMFactory(
                            configService,
                        ).createTypeOrmOptions(),
                }),
                TypeOrmModule.forFeature(
                    ANALYTICS_ENTITIES,
                    ANALYTICS_DATA_SOURCE,
                ),
                MongooseModule.forFeature([
                    {
                        name: PullRequestsModel.name,
                        schema: PullRequestsSchema,
                    },
                    {
                        name: CodeReviewFeedbackModel.name,
                        schema: CodeReviewFeedbackSchema,
                    },
                ]),
            ],
            providers: [
                PullRequestIngestionService,
                FeedbackIngestionService,
                ReviewOperationalIngestionService,
                BackfillOrchestratorService,
                PullRequestClassifierService,
            ],
            exports: [
                TypeOrmModule,
                PullRequestIngestionService,
                FeedbackIngestionService,
                ReviewOperationalIngestionService,
                BackfillOrchestratorService,
                PullRequestClassifierService,
            ],
        };
    }

    /**
     * Feature-level registration for modules that run UNDER a root which has
     * already established the analytics DataSource (e.g. CockpitModule under
     * ApiModule). Same providers/exports as forRoot() but WITHOUT
     * TypeOrmModule.forRootAsync — registering the named "analytics" connection
     * a second time throws DuplicateDataSourceException in @nestjs/typeorm.
     */
    static forFeature(): DynamicModule {
        return {
            module: AnalyticsWarehouseModule,
            imports: [
                TypeOrmModule.forFeature(
                    ANALYTICS_ENTITIES,
                    ANALYTICS_DATA_SOURCE,
                ),
                MongooseModule.forFeature([
                    {
                        name: PullRequestsModel.name,
                        schema: PullRequestsSchema,
                    },
                    {
                        name: CodeReviewFeedbackModel.name,
                        schema: CodeReviewFeedbackSchema,
                    },
                ]),
            ],
            providers: [
                PullRequestIngestionService,
                FeedbackIngestionService,
                ReviewOperationalIngestionService,
                BackfillOrchestratorService,
                PullRequestClassifierService,
            ],
            exports: [
                TypeOrmModule,
                PullRequestIngestionService,
                FeedbackIngestionService,
                ReviewOperationalIngestionService,
                BackfillOrchestratorService,
                PullRequestClassifierService,
            ],
        };
    }
}
