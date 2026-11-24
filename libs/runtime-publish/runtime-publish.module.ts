import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ChecksAdapterFactory } from '@libs/core/infrastructure/pipeline/services/checks-adapter.factory';
import { NullChecksAdapter } from '@libs/core/infrastructure/pipeline/services/null-checks.adapter';
import { createLogger } from '@libs/core/log/logger';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { ForgejoChecksService } from '@libs/platform/infrastructure/adapters/services/forgejo/forgejo-checks.service';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';
import { ForgejoModule } from '@libs/platform/modules/forgejo.module';
import { GithubModule } from '@libs/platform/modules/github.module';
import { PlatformCoreModule } from '@libs/platform/modules/platform-core.module';
import { PULL_REQUESTS_REPOSITORY_TOKEN, type IPullRequestsRepository } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { PlatformDataModule } from '@libs/platformData/platformData.module';
import { TypeOrmSql } from '@libs/runtime/api/infrastructure/typeorm-sql';

import { PublishRuntimeRequestUseCase } from './application/publish-runtime-request.use-case';
import { PublishSuiteCheckUseCase } from './application/publish-suite-check.use-case';
import { RedriveRuntimePublicationsUseCase } from './application/redrive-runtime-publications.use-case';
import { RUNTIME_PR_CHECK_SLOT_STORE_TOKEN } from './domain/pull-request-check-slot';
import { RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN } from './domain/pull-request-comment-slot';
import { RUNTIME_RUN_TARGET_STORE_TOKEN } from './domain/run-target';
import {
    RUNTIME_PUBLICATION_STORE_TOKEN,
    RUNTIME_PUBLISH_CHECKS_TOKEN,
    RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN,
    RUNTIME_PUBLISH_COMMENT_AUTHOR_TOKEN,
    RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN,
    RUNTIME_PUBLISH_METRICS_TOKEN,
    RUNTIME_PUBLISH_PREVIEW_OFFER_TOKEN,
    RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN,
    RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN,
} from './domain/runtime-publish.ports';
import { IntegrationConfigRepositoryResolver } from './infrastructure/integration-config-repository.resolver';
import { OtelPublishMetrics } from './infrastructure/otel-publish.metrics';
import { PlatformCommentAuthor } from './infrastructure/platform-comment-author';
import { ProductPreviewOfferReader } from './infrastructure/product-preview-offer.reader';
import { PullRequestSuggestionResolver } from './infrastructure/pull-request-suggestion.resolver';
import { RuntimePublicationRedriveCron } from './infrastructure/runtime-publication-redrive.cron';
import { RuntimePublishRequestedConsumer } from './infrastructure/runtime-publish-requested.consumer';
import { RuntimeRunTargetModel } from './infrastructure/runtime-run-target.model';
import { TypeOrmCheckSlotStore } from './infrastructure/typeorm-check-slot.store';
import { TypeOrmCommentSlotStore } from './infrastructure/typeorm-comment-slot.store';
import { TypeOrmPublicationStore } from './infrastructure/typeorm-publication.store';
import { TypeOrmRunTargetStore } from './infrastructure/typeorm-run-target.store';

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
        // The review record a reply answers (pullRequests): read through the product's repository.
        forwardRef(() => PlatformDataModule),
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
            // Who Kody posts as: a lost create adopts only its own marked comment (review 2026-11-14, #11).
            provide: RUNTIME_PUBLISH_COMMENT_AUTHOR_TOKEN,
            useFactory: (codeManagement: CodeManagementService, github: GithubService) => new PlatformCommentAuthor(codeManagement, () => github.getGithubAppId()),
            inject: [CodeManagementService, GithubService],
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
            // runtime_publications in the product Postgres: its primary key on the
            // idempotency key is what makes the dedup atomic (the migration makes it).
            provide: RUNTIME_PUBLICATION_STORE_TOKEN,
            useFactory: (source: DataSource) => new TypeOrmPublicationStore(new TypeOrmSql(source)),
            inject: [DataSource],
        },
        {
            // runtime_pr_comments: the primary key on the PR lets one delivery hold its comment.
            provide: RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN,
            useFactory: (source: DataSource) => new TypeOrmCommentSlotStore(new TypeOrmSql(source)),
            inject: [DataSource],
        },
        {
            // runtime_pr_checks: one row per check on a head orders the Runs that share it (V-02).
            provide: RUNTIME_PR_CHECK_SLOT_STORE_TOKEN,
            useFactory: (source: DataSource) => new TypeOrmCheckSlotStore(new TypeOrmSql(source)),
            inject: [DataSource],
        },
        {
            provide: RUNTIME_PUBLISH_METRICS_TOKEN,
            useFactory: () => new OtelPublishMetrics(),
        },
        {
            provide: RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN,
            useFactory: (pullRequests: IPullRequestsRepository) =>
                new PullRequestSuggestionResolver(pullRequests.getNativeCollection()),
            inject: [PULL_REQUESTS_REPOSITORY_TOKEN],
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
        {
            // The preview line of the comment and the check: only with RUNTIME_PREVIEW_DOMAIN here and the org's previews on.
            provide: RUNTIME_PUBLISH_PREVIEW_OFFER_TOKEN,
            useFactory: (source: DataSource) => new ProductPreviewOfferReader(new TypeOrmSql(source), process.env.RUNTIME_PREVIEW_DOMAIN),
            inject: [DataSource],
        },
        PublishRuntimeRequestUseCase,
        PublishSuiteCheckUseCase,
        RuntimePublishRequestedConsumer,
        // Re-drives final publications the broker lost (publication-redrive.ts).
        RedriveRuntimePublicationsUseCase,
        RuntimePublicationRedriveCron,
    ],
})
export class RuntimePublishModule {}
