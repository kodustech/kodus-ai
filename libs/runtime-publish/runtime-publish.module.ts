import { Module, forwardRef } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Collection } from 'mongodb';
import type { Connection } from 'mongoose';

import { ChecksAdapterFactory } from '@libs/core/infrastructure/pipeline/services/checks-adapter.factory';
import { NullChecksAdapter } from '@libs/core/infrastructure/pipeline/services/null-checks.adapter';
import { createLogger } from '@libs/core/log/logger';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { ForgejoChecksService } from '@libs/platform/infrastructure/adapters/services/forgejo/forgejo-checks.service';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import { ForgejoModule } from '@libs/platform/modules/forgejo.module';
import { GithubModule } from '@libs/platform/modules/github.module';
import { PlatformCoreModule } from '@libs/platform/modules/platform-core.module';

import { PublishRuntimeRequestUseCase } from './application/publish-runtime-request.use-case';
import { RedriveRuntimePublicationsUseCase } from './application/redrive-runtime-publications.use-case';
import {
    RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN,
    RUNTIME_PR_COMMENTS_COLLECTION,
    type PullRequestCommentSlot,
} from './domain/pull-request-comment-slot';
import { RUNTIME_RUN_TARGET_STORE_TOKEN } from './domain/run-target';
import {
    RUNTIME_PUBLICATIONS_COLLECTION,
    type RuntimePublication,
} from './domain/runtime-publication';
import {
    RUNTIME_PUBLICATION_STORE_TOKEN,
    RUNTIME_PUBLISH_CHECKS_TOKEN,
    RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN,
    RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN,
    RUNTIME_PUBLISH_METRICS_TOKEN,
    RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN,
    RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN,
} from './domain/runtime-publish.ports';
import { IntegrationConfigRepositoryResolver } from './infrastructure/integration-config-repository.resolver';
import { MongoCommentSlotStore } from './infrastructure/mongo-comment-slot.store';
import { MongoPublicationStore } from './infrastructure/mongo-publication.store';
import { OtelPublishMetrics } from './infrastructure/otel-publish.metrics';
import {
    PULL_REQUESTS_COLLECTION,
    PullRequestSuggestionResolver,
} from './infrastructure/pull-request-suggestion.resolver';
import { RuntimePublicationRedriveCron } from './infrastructure/runtime-publication-redrive.cron';
import { RuntimePublishRequestedConsumer } from './infrastructure/runtime-publish-requested.consumer';
import { RuntimeRunTargetModel } from './infrastructure/runtime-run-target.model';
import { TypeOrmRunTargetStore } from './infrastructure/typeorm-run-target.store';

// Mongoose bundles its own copy of the driver; the stores are typed against
// the top-level `mongodb` package, so the collection is cast at this seam.
function collectionOf<T>(connection: Connection, name: string): Collection<T> {
    const db = connection.db;
    if (!db) {
        throw new Error(`Mongo connection is not open; cannot read ${name}`);
    }
    return db.collection(name) as unknown as Collection<T>;
}

/**
 * The product worker's publisher for Kody Runtime (ADR-052): consumes
 * workflow.jobs.runtime_publish.queue and publishes comments and checks
 * with the product's Git credentials. Code-review worker role only, and only
 * where Kody Runtime is on (isKodyRuntimeEnabled).
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([RuntimeRunTargetModel]),
        forwardRef(() => PlatformCoreModule),
        forwardRef(() => GithubModule),
        forwardRef(() => ForgejoModule),
        forwardRef(() => IntegrationConfigCoreModule),
    ],
    providers: [
        GithubChecksService,
        ForgejoChecksService,
        NullChecksAdapter,
        ChecksAdapterFactory,
        IntegrationConfigRepositoryResolver,
        {
            provide: RUNTIME_PUBLISH_CHECKS_TOKEN,
            useExisting: ChecksAdapterFactory,
        },
        {
            provide: RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN,
            useExisting: CodeManagementService,
        },
        {
            provide: RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN,
            useExisting: IntegrationConfigRepositoryResolver,
        },
        {
            // Read only here: the product API writes it at enqueue time.
            provide: RUNTIME_RUN_TARGET_STORE_TOKEN,
            useClass: TypeOrmRunTargetStore,
        },
        {
            provide: RUNTIME_PUBLICATION_STORE_TOKEN,
            // The unique indexes are what make the dedup atomic: without them a
            // race publishes twice, so a failure here fails the worker's start.
            useFactory: async (connection: Connection) => {
                const collection = collectionOf<RuntimePublication>(
                    connection,
                    RUNTIME_PUBLICATIONS_COLLECTION,
                );
                await MongoPublicationStore.ensureIndexes(collection);
                return new MongoPublicationStore(collection);
            },
            inject: [getConnectionToken()],
        },
        {
            provide: RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN,
            useFactory: async (connection: Connection) => {
                const collection = collectionOf<PullRequestCommentSlot>(
                    connection,
                    RUNTIME_PR_COMMENTS_COLLECTION,
                );
                await MongoCommentSlotStore.ensureIndexes(collection);
                return new MongoCommentSlotStore(collection);
            },
            inject: [getConnectionToken()],
        },
        {
            provide: RUNTIME_PUBLISH_METRICS_TOKEN,
            useFactory: () => new OtelPublishMetrics(),
        },
        {
            provide: RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN,
            useFactory: (connection: Connection) =>
                new PullRequestSuggestionResolver(
                    collectionOf(connection, PULL_REQUESTS_COLLECTION),
                ),
            inject: [getConnectionToken()],
        },
        {
            // Links in the comment go to the dashboard only (Run page, settings).
            provide: RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN,
            useFactory: () => {
                const url = process.env.API_FRONTEND_URL ?? '';
                if (!url) {
                    createLogger('RuntimePublishModule').warn({
                        message: 'API_FRONTEND_URL is empty: Runtime comments go out without links to the Run',
                        context: 'RuntimePublishModule',
                    });
                }
                return url;
            },
        },
        PublishRuntimeRequestUseCase,
        RuntimePublishRequestedConsumer,
        // Re-drives final publications the broker lost (publication-redrive.ts).
        RedriveRuntimePublicationsUseCase,
        RuntimePublicationRedriveCron,
    ],
})
export class RuntimePublishModule {}
