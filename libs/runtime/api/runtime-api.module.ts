import { forwardRef, Module } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN, type IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import type { Db } from 'mongodb';
import type { Connection } from 'mongoose';

import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { RUNTIME_RUN_TARGET_STORE_TOKEN } from '@libs/runtime-publish/domain/run-target';
import { RUNTIME_PUBLICATION_READER_TOKEN, RUNTIME_PUBLICATIONS_COLLECTION } from '@libs/runtime-publish/domain/runtime-publication';
import { MongoPublicationReader } from '@libs/runtime-publish/infrastructure/mongo-publication.store';
import { RuntimeRunTargetModel } from '@libs/runtime-publish/infrastructure/runtime-run-target.model';
import { TypeOrmRunTargetStore } from '@libs/runtime-publish/infrastructure/typeorm-run-target.store';
import { FileRunStreamStore } from '@libs/runtime/run';

import { RuntimeRunAccessService } from './application/run-access.service';
import { RuntimeRunCostService } from './application/run-cost.service';
import { CatalogRuntimeModelPricing } from './infrastructure/catalog-model-pricing.adapter';
import { ApplyBlockerFixUseCase } from './application/use-cases/apply-blocker-fix.use-case';
import { ProposeInferredRecipeUseCase } from './application/use-cases/propose-inferred-recipe.use-case';
import { ListEnvironmentLessonsUseCase, UpdateEnvironmentLessonUseCase } from './application/use-cases/lessons.use-cases';
import { ApproveEgressUseCase } from './application/use-cases/approve-egress.use-case';
import { ApproveForkRunUseCase } from './application/use-cases/approve-fork-run.use-case';
import {
    CreateCellRegistrationTokenUseCase,
    ListRuntimeCellsUseCase,
    RevokeRuntimeCellUseCase,
} from './application/use-cases/cells.use-cases';
import { GetRuntimeRunEvidenceUseCase } from './application/use-cases/get-run-evidence.use-case';
import { RuntimePoolController } from './application/pool-controller.service';
import { RuntimePoolSchedulerCron } from './infrastructure/runtime-pool-scheduler.cron';
import { GetRuntimeRunReproductionUseCase } from './application/use-cases/get-run-reproduction.use-case';
import { SetFindingFeedbackUseCase } from './application/use-cases/finding-feedback.use-case';
import { SetFindingIntentUseCase } from './application/use-cases/finding-intent.use-case';
import { GetRuntimeRunUseCase } from './application/use-cases/get-run.use-case';
import { SimulateRuntimeRunUseCase } from './application/use-cases/simulate.use-case';
import { RuntimePullRequestTriggerUseCase } from './application/use-cases/pull-request-trigger.use-case';
import { RuntimeRunRequestBuilder } from './application/run-request-builder.service';
import { ListRuntimeRunsUseCase } from './application/use-cases/list-runs.use-case';
import { RuntimeLlmGatewayUseCase } from './application/use-cases/llm-gateway.use-case';
import { RuntimeRecipeAuthorUseCase } from './application/use-cases/recipe-author.use-case';
import { RuntimeTestPlannerUseCase } from './application/use-cases/test-planner.use-case';
import { RuntimeModelTurnGatewayUseCase } from './application/use-cases/model-turn-gateway.use-case';
import { RuntimePlannerSourceUseCase } from './application/use-cases/planner-source.use-case';
import { RUNTIME_MODEL_TURN_PROVIDER, RUNTIME_MODEL_TURN_RECEIPTS } from './domain/model-turn';
import { ByokRuntimeModelTurnProvider } from './infrastructure/byok-model-turn.provider';
import { MongoModelTurnReceipts } from './infrastructure/mongo-model-turn-receipts.store';
import { ReadRuntimeRunStreamUseCase } from './application/use-cases/read-run-stream.use-case';
import { RunRuntimeAgainUseCase } from './application/use-cases/run-again.use-case';
import { SetTeamKeyRepositoriesUseCase } from './application/use-cases/set-team-key-repositories.use-case';
import { ClearRuntimeStopUseCase, StopRuntimeUseCase } from './application/use-cases/stop-runtime.use-case';
import {
    CreateRuntimeEnvironmentUseCase,
    GetRuntimeEnvironmentUseCase,
    ListEnvironmentBlockersUseCase,
    ListRuntimeEnvironmentsUseCase,
    RequestEnvironmentSetupUseCase,
    EnvironmentViewBuilder,
    UpdateEnvironmentSettingsUseCase,
} from './application/use-cases/environments.use-cases';
import {
    GetRuntimeSettingsUseCase,
    UpdateRuntimeOrgSettingsUseCase,
    UpdateRuntimeRepositorySettingsUseCase,
} from './application/use-cases/settings.use-cases';
import {
    RUNTIME_AGENT_RUNNER_FACTORY,
    RUNTIME_API_CONFIG,
    RUNTIME_CELL_READER,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_LLM_PROVIDER,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_REPO_TOKEN_ISSUER,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_RUN_STREAM_STORE,
    RUNTIME_TEAM_REPOSITORIES,
    RUNTIME_SETTINGS_STORE,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_LESSON_READER,
    RUNTIME_ORG_REPOSITORIES,
    type RuntimeApiConfig,
    RUNTIME_EGRESS_READER,
    RUNTIME_CLAIM_USAGE_READER,
    RUNTIME_FINDING_FEEDBACK_STORE,
    RUNTIME_FINDING_INTENT_STORE,
    RUNTIME_MODEL_PRICING,
} from './domain/ports';
import {
    CodeManagementRuntimeGitAdapter,
    IntegrationConfigOrgRepositories,
    IntegrationConfigTeamRepositories,
} from './infrastructure/code-management-git.adapter';
import { PgRuntimeEgressReader } from './infrastructure/pg-runtime-egress.reader';
import { PgRuntimeClaimUsageReader } from './infrastructure/pg-runtime-claim-usage.reader';
import { PgRuntimeRunStreamReader } from './infrastructure/pg-runtime-run-stream.reader';
import {
    RuntimeEnvironmentModel,
    RuntimeFindingFeedbackModel,
    RuntimeFindingIntentModel,
    RuntimeRepositorySettingsModel,
    RuntimeSettingsModel,
} from './infrastructure/runtime-product.models';
import {
    TypeOrmFindingFeedbackStore,
    TypeOrmFindingIntentStore,
    TypeOrmProductEnvironmentStore,
    TypeOrmRuntimeSettingsStore,
} from './infrastructure/typeorm-runtime-product.stores';
import { MongoRuntimeLlmBudgetStore } from './infrastructure/mongo-llm-budget.store';
import { MongoEnvironmentSetupReader, MongoLessonReader, ProjectionEnvironmentReader, ReadOnlyRunProjectionStore } from './infrastructure/mongo-runtime-readers';
import { PgRuntimeCellReader } from './infrastructure/pg-runtime-cell.reader';
import { loadRuntimeApiConfig } from './infrastructure/runtime-api.config';
import { RuntimeMongo } from './infrastructure/runtime-mongo';
import { RuntimeReaderAuthGuard } from './infrastructure/runtime-reader.guard';
import { ByokRuntimeAgentRunnerFactory, ByokRuntimeLlmProvider, permissionSlotResolver } from './infrastructure/byok-runtime-llm.provider';
import { CodeManagementRepoTokenIssuer } from './infrastructure/repo-token-issuer.adapter';
import { DevStubRepoTokenIssuer, DevStubRuntimeGit, devGitStubFile } from './infrastructure/dev-stub-git.adapter';
import { RUNTIME_PLATFORM_RESOLVER, RuntimeRunEnqueuer } from './application/runtime-run-enqueuer.service';
import { RuntimeSetupRequester } from './application/runtime-setup-requester.service';
import { RuntimeEnvToolsService } from './application/env-tools.service';
import { ListRuntimeAuditUseCase } from './application/use-cases/env-audit.use-case';
import { RUNTIME_ENV_AUDIT_STORE, RUNTIME_ENV_SESSION_PORT } from './domain/env-tools';
import { HttpEnvSessionClient, loadEnvSessionClientConfig } from './infrastructure/http-env-session.client';
import { MongoRuntimeEnvAuditStore } from './infrastructure/mongo-env-audit.store';
import { ExternalFindingsService } from './application/external-findings.service';
import { RUNTIME_EXTERNAL_FINDINGS, RUNTIME_EXTERNAL_FINDINGS_STORE, RUNTIME_EXTERNAL_STOP_READER } from './domain/external-findings';
import { RuntimeExternalSubmissionModel, RuntimeExternalMessageModel } from './infrastructure/runtime-external-finding.models';
import { TypeOrmExternalFindingsStore } from './infrastructure/typeorm-external-findings.store';
import { PgExternalStopReader } from './infrastructure/pg-external-stop.reader';
import { RUNTIME_A2A_BASE_URL, RuntimeA2AAdapter } from './infrastructure/a2a/runtime-a2a.adapter';
import { RuntimeA2ABearerGuard } from './infrastructure/a2a/runtime-a2a.guard';

const useCases = [
    ListRuntimeRunsUseCase,
    GetRuntimeRunUseCase,
    ReadRuntimeRunStreamUseCase,
    GetRuntimeRunEvidenceUseCase,
    GetRuntimeRunReproductionUseCase,
    RunRuntimeAgainUseCase,
    ApproveForkRunUseCase,
    ApproveEgressUseCase,
    StopRuntimeUseCase,
    ClearRuntimeStopUseCase,
    ListRuntimeEnvironmentsUseCase,
    GetRuntimeEnvironmentUseCase,
    ListEnvironmentBlockersUseCase,
    ApplyBlockerFixUseCase,
    ProposeInferredRecipeUseCase,
    ListEnvironmentLessonsUseCase,
    UpdateEnvironmentLessonUseCase,
    CreateRuntimeEnvironmentUseCase,
    RequestEnvironmentSetupUseCase,
    UpdateEnvironmentSettingsUseCase,
    GetRuntimeSettingsUseCase,
    UpdateRuntimeOrgSettingsUseCase,
    UpdateRuntimeRepositorySettingsUseCase,
    CreateCellRegistrationTokenUseCase,
    ListRuntimeCellsUseCase,
    RevokeRuntimeCellUseCase,
    SetTeamKeyRepositoriesUseCase,
    RuntimeLlmGatewayUseCase,
    RuntimeRecipeAuthorUseCase,
    RuntimeTestPlannerUseCase,
    RuntimeModelTurnGatewayUseCase,
    RuntimePlannerSourceUseCase,
    SetFindingFeedbackUseCase,
    SetFindingIntentUseCase,
    SimulateRuntimeRunUseCase,
    RuntimePullRequestTriggerUseCase,
    ListRuntimeAuditUseCase,
];

/**
 * The API side of the Kody Runtime (§4 "API e Dashboard", §7). It reads the
 * Runtime stores and writes only product state and outbox rows; it never
 * executes Runtime work (ADR-025).
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([
            RuntimeEnvironmentModel,
            RuntimeSettingsModel,
            RuntimeRepositorySettingsModel,
            RuntimeFindingFeedbackModel,
            RuntimeFindingIntentModel,
            RuntimeRunTargetModel,
            RuntimeExternalSubmissionModel,
            RuntimeExternalMessageModel,
        ]),
        forwardRef(() => PermissionsModule),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => TeamModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => IntegrationConfigModule),
    ],
    providers: [
        RuntimePoolController,
        RuntimePoolSchedulerCron,
        { provide: RUNTIME_API_CONFIG, useFactory: () => loadRuntimeApiConfig() },
        { provide: RUNTIME_CLOCK, useValue: () => new Date() },
        RuntimeMongo,
        {
            provide: RUNTIME_RUN_PROJECTION_STORE,
            inject: [RuntimeMongo],
            useFactory: (mongo: RuntimeMongo) => new ReadOnlyRunProjectionStore(mongo.db),
        },
        {
            provide: RUNTIME_ENVIRONMENT_READER,
            inject: [RuntimeMongo],
            useFactory: (mongo: RuntimeMongo) => new ProjectionEnvironmentReader(mongo.db),
        },
        {
            provide: RUNTIME_ENVIRONMENT_SETUP_READER,
            inject: [RuntimeMongo],
            useFactory: (mongo: RuntimeMongo) => new MongoEnvironmentSetupReader(mongo.db),
        },
        {
            provide: RUNTIME_LESSON_READER,
            inject: [RuntimeMongo],
            useFactory: (mongo: RuntimeMongo) => new MongoLessonReader(mongo.db),
        },
        {
            provide: RUNTIME_RUN_STREAM_STORE,
            inject: [RUNTIME_API_CONFIG],
            // Postgres by default (read-only URL); the file volume only when RUNTIME_STREAM_STORE=file, or as the
            // cutover read of a Run written before the switch while RUNTIME_STREAM_DIR is still set.
            useFactory: (config: RuntimeApiConfig) =>
                config.streamStore === 'file'
                    ? new FileRunStreamStore(config.streamDir || '/tmp/kody-runtime-streams')
                    : new PgRuntimeRunStreamReader(config.runtimeDatabaseReadUrl, config.streamDir ? new FileRunStreamStore(config.streamDir) : undefined),
        },
        {
            provide: RUNTIME_CELL_READER,
            inject: [RUNTIME_API_CONFIG],
            useFactory: (config: RuntimeApiConfig) => new PgRuntimeCellReader(config.runtimeDatabaseReadUrl),
        },
        CodeManagementRuntimeGitAdapter,
        CodeManagementRepoTokenIssuer,
        // RUNTIME_DEV_GIT_STUB_FILE (dev and e2e only, refused in production): Git answered from a file.
        {
            provide: RUNTIME_GIT_PORT,
            inject: [CodeManagementRuntimeGitAdapter],
            useFactory: (real: CodeManagementRuntimeGitAdapter) => {
                const file = devGitStubFile();
                return file ? new DevStubRuntimeGit(file, real) : real;
            },
        },
        {
            provide: RUNTIME_REPO_TOKEN_ISSUER,
            inject: [CodeManagementRepoTokenIssuer],
            useFactory: (real: CodeManagementRepoTokenIssuer) => {
                const file = devGitStubFile();
                return file ? new DevStubRepoTokenIssuer(file, real) : real;
            },
        },
        {
            provide: RUNTIME_LLM_PROVIDER,
            inject: [PermissionValidationService],
            useFactory: (svc: PermissionValidationService) => new ByokRuntimeLlmProvider(permissionSlotResolver(svc)),
        },
        { provide: RUNTIME_MODEL_TURN_PROVIDER, inject: [PermissionValidationService], useFactory: (svc: PermissionValidationService) => new ByokRuntimeModelTurnProvider(permissionSlotResolver(svc)) },
        { provide: RUNTIME_MODEL_TURN_RECEIPTS, inject: [getConnectionToken()], useFactory: (connection: Connection) => new MongoModelTurnReceipts(async () => connection.db as unknown as Db) },
        {
            // Kody's recipe author runs here on the same slot as the gateway; the worker never gets the key (ADR-057).
            provide: RUNTIME_AGENT_RUNNER_FACTORY,
            inject: [PermissionValidationService],
            useFactory: (svc: PermissionValidationService) => new ByokRuntimeAgentRunnerFactory(permissionSlotResolver(svc)),
        },
        {
            // The product Mongo, never RUNTIME_MONGO_URL: the budget is product state, beside the telemetry of the same calls.
            provide: RUNTIME_LLM_USAGE_STORE,
            inject: [getConnectionToken()],
            useFactory: (connection: Connection) => new MongoRuntimeLlmBudgetStore(async () => connection.db as unknown as Db),
        },
        { provide: RUNTIME_TEAM_REPOSITORIES, useClass: IntegrationConfigTeamRepositories },
        { provide: RUNTIME_ORG_REPOSITORIES, useClass: IntegrationConfigOrgRepositories },
        { provide: RUNTIME_SETTINGS_STORE, useClass: TypeOrmRuntimeSettingsStore },
        { provide: RUNTIME_PRODUCT_ENVIRONMENT_STORE, useClass: TypeOrmProductEnvironmentStore },
        { provide: RUNTIME_FINDING_FEEDBACK_STORE, useClass: TypeOrmFindingFeedbackStore },
        { provide: RUNTIME_FINDING_INTENT_STORE, useClass: TypeOrmFindingIntentStore },
        {
            provide: RUNTIME_EGRESS_READER,
            inject: [RUNTIME_API_CONFIG],
            useFactory: (config: RuntimeApiConfig) => new PgRuntimeEgressReader(config.runtimeDatabaseReadUrl),
        },
        EnvironmentViewBuilder,
        RuntimeRunAccessService,
        // The cost of a Run (§13 PR 5): the gateway's counters priced by the product's price list,
        // and the machine time by what the Run's claims held (runtime_claims, read only).
        { provide: RUNTIME_MODEL_PRICING, useClass: CatalogRuntimeModelPricing },
        {
            provide: RUNTIME_CLAIM_USAGE_READER,
            inject: [RUNTIME_API_CONFIG],
            useFactory: (config: RuntimeApiConfig) => new PgRuntimeClaimUsageReader(config.runtimeDatabaseReadUrl),
        },
        RuntimeRunCostService,
        { provide: RUNTIME_RUN_TARGET_STORE_TOKEN, useClass: TypeOrmRunTargetStore },
        {
            // What the product worker published on the PR (product Mongo, read only): the Run page's source of truth.
            provide: RUNTIME_PUBLICATION_READER_TOKEN,
            inject: [getConnectionToken()],
            useFactory: (connection: Connection) =>
                new MongoPublicationReader((connection.db as unknown as Db).collection(RUNTIME_PUBLICATIONS_COLLECTION)),
        },
        { provide: RUNTIME_PLATFORM_RESOLVER, useExisting: CodeManagementService },
        RuntimeRunEnqueuer,
        RuntimeRunRequestBuilder,
        RuntimeSetupRequester,
        RuntimeReaderAuthGuard,
        // The /mcp/env tools (Inc. 1): the worker's env-session listener, and the env_exec audit in the product Mongo.
        { provide: RUNTIME_ENV_SESSION_PORT, useFactory: () => new HttpEnvSessionClient(loadEnvSessionClientConfig()) },
        {
            provide: RUNTIME_ENV_AUDIT_STORE,
            inject: [getConnectionToken()],
            useFactory: (connection: Connection) => new MongoRuntimeEnvAuditStore(async () => connection.db as unknown as Db),
        },
        RuntimeEnvToolsService,
        {
            provide: RUNTIME_EXTERNAL_FINDINGS_STORE,
            inject: [DataSource, OUTBOX_MESSAGE_REPOSITORY_TOKEN],
            useFactory: (source: DataSource, outbox: IOutboxMessageRepository) => new TypeOrmExternalFindingsStore(source, outbox),
        },
        {
            provide: RUNTIME_EXTERNAL_STOP_READER,
            inject: [RUNTIME_API_CONFIG],
            useFactory: (config: RuntimeApiConfig) => new PgExternalStopReader(config.runtimeDatabaseReadUrl),
        },
        ExternalFindingsService,
        { provide: RUNTIME_EXTERNAL_FINDINGS, useExisting: ExternalFindingsService },
        {
            provide: RUNTIME_A2A_BASE_URL,
            inject: [RUNTIME_API_CONFIG],
            useFactory: (config: RuntimeApiConfig) => config.a2aBaseUrl,
        },
        RuntimeA2AAdapter,
        RuntimeA2ABearerGuard,
        ...useCases,
    ],
    exports: [RUNTIME_RUN_PROJECTION_STORE, RUNTIME_CLOCK, ...useCases, RuntimeReaderAuthGuard, RuntimeRunEnqueuer, RuntimeEnvToolsService, RuntimePoolController, RuntimeA2AAdapter, RuntimeA2ABearerGuard],
})
export class RuntimeApiModule {}
