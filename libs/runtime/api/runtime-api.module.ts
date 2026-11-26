import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN, type IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';

import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { GithubModule } from '@libs/platform/modules/github.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { RUNTIME_RUN_TARGET_STORE_TOKEN } from '@libs/runtime-publish/domain/run-target';
import { RUNTIME_PUBLICATION_READER_TOKEN } from '@libs/runtime-publish/domain/runtime-publication';
import { RUNTIME_SKIPPED_TRIGGER_REPLY_TOKEN, SkippedTriggerReplyPublisher } from '@libs/runtime-publish/application/skipped-trigger-reply';
import { IntegrationConfigRepositoryResolver } from '@libs/runtime-publish/infrastructure/integration-config-repository.resolver';
import { PlatformCommentAuthor } from '@libs/runtime-publish/infrastructure/platform-comment-author';
import { TypeOrmPublicationReader, TypeOrmPublicationStore } from '@libs/runtime-publish/infrastructure/typeorm-publication.store';
import { RuntimeRunTargetModel } from '@libs/runtime-publish/infrastructure/runtime-run-target.model';
import { TypeOrmRunTargetStore } from '@libs/runtime-publish/infrastructure/typeorm-run-target.store';
import { FileRunStreamStore } from '@libs/runtime/run';

import { RuntimeRunAccessService } from './application/run-access.service';
import { RuntimeRunCostService } from './application/run-cost.service';
import { TelemetryRuntimeLlmSpendReader } from './infrastructure/telemetry-llm-spend.reader';
import { PgRuntimeUsageReportReader } from './infrastructure/pg-runtime-usage-report.reader';
import { GetRuntimeUsageReportUseCase } from './application/use-cases/usage-report.use-case';
import { GetRuntimeHealthUseCase } from './application/use-cases/runtime-health.use-case';
import { GetRuntimeSpeedUseCase } from './application/use-cases/runtime-speed.use-case';
import { PgRuntimeHealthReader, RUNTIME_HEALTH_READER } from './infrastructure/pg-runtime-health.reader';
import { PgRuntimeSpeedReader, RUNTIME_SPEED_READER } from './infrastructure/pg-runtime-speed.reader';
import { ApplyBlockerFixUseCase } from './application/use-cases/apply-blocker-fix.use-case';
import { ProposeInferredRecipeUseCase } from './application/use-cases/propose-inferred-recipe.use-case';
import { ListEnvironmentLessonsUseCase, UpdateEnvironmentLessonUseCase } from './application/use-cases/lessons.use-cases';
import { RuntimeEgressAccess } from './application/egress-access.service';
import { ApproveEgressUseCase } from './application/use-cases/approve-egress.use-case';
import { OrgEgressUseCases, RevokeEgressUseCase } from './application/use-cases/egress-access.use-cases';
import { ApproveForkRunUseCase } from './application/use-cases/approve-fork-run.use-case';
import {
    CreateCellRegistrationTokenUseCase,
    ListCellRegistrationTokensUseCase,
    ListRuntimeCellsUseCase,
    RevokeCellRegistrationTokenUseCase,
    RevokeRuntimeCellUseCase,
} from './application/use-cases/cells.use-cases';
import { GetRuntimeRunEvidenceUseCase } from './application/use-cases/get-run-evidence.use-case';
import { RuntimePoolController } from './application/pool-controller.service';
import { RuntimePoolSchedulerCron } from './infrastructure/runtime-pool-scheduler.cron';
import { RuntimePullRequestSessionSweepCron } from './infrastructure/runtime-pr-session-sweep.cron';
import { PgPullRequestSessionsReader } from './infrastructure/pg-pull-request-sessions.reader';
import { RuntimePullRequestSessionSweep } from './application/use-cases/pull-request-session-sweep.use-case';
import { GetRuntimeRunReproductionUseCase } from './application/use-cases/get-run-reproduction.use-case';
import { SetFindingFeedbackUseCase } from './application/use-cases/finding-feedback.use-case';
import { SetFindingIntentUseCase } from './application/use-cases/finding-intent.use-case';
import { KeepRuntimeCheckUseCase, ListRuntimeKeptChecksUseCase, RemoveRuntimeKeptCheckUseCase } from './application/use-cases/kept-checks.use-cases';
import { GetRuntimeRunUseCase } from './application/use-cases/get-run.use-case';
import { SimulateRuntimeRunUseCase } from './application/use-cases/simulate.use-case';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { ReleaseTrackRuntimeRelease } from './infrastructure/release-track-runtime-release.gate';
import { RuntimePullRequestTriggerUseCase } from './application/use-cases/pull-request-trigger.use-case';
import { RuntimeRunRequestBuilder } from './application/run-request-builder.service';
import { LinkedTasksAdapter } from './infrastructure/linked-tasks.adapter';
import { RuntimeEnvironmentMembers } from './application/environment-members.service';
import { EnvironmentRepositoriesUseCase } from './application/use-cases/environment-repositories.use-cases';
import { ListRuntimeRunsUseCase } from './application/use-cases/list-runs.use-case';
import { ListPullRequestRunsUseCase } from './application/use-cases/pull-request-runs.use-case';
import { RequestPullRequestRunUseCase } from './application/use-cases/request-pull-request-run.use-case';
import { RUNTIME_PULL_REQUEST_RUNS_READER } from './domain/pull-request-runs';
import { PgPullRequestRunsReader } from './infrastructure/pg-pull-request-runs.reader';
import { RuntimeLlmGatewayUseCase } from './application/use-cases/llm-gateway.use-case';
import { RuntimeRecipeAuthorUseCase } from './application/use-cases/recipe-author.use-case';
import { RuntimeSetupRepoTokensUseCase } from './application/use-cases/setup-repo-tokens.use-case';
import { RUNTIME_RECIPE_AUTHOR_RECEIPTS, RUNTIME_SETUP_CALL_COUNTER } from './domain/setup-calls';
import { TypeOrmRecipeAuthorReceipts, TypeOrmSetupCallCounter } from './infrastructure/typeorm-setup-calls.store';
import { RuntimeTestPlannerUseCase } from './application/use-cases/test-planner.use-case';
import { RuntimeModelTurnGatewayUseCase } from './application/use-cases/model-turn-gateway.use-case';
import { RuntimePlannerSourceUseCase } from './application/use-cases/planner-source.use-case';
import { RUNTIME_MODEL_TURN_PROVIDER, RUNTIME_MODEL_TURN_RECEIPTS } from './domain/model-turn';
import { ByokRuntimeModelTurnProvider } from './infrastructure/byok-model-turn.provider';
import { TypeOrmModelTurnReceipts } from './infrastructure/typeorm-model-turn-receipts.store';
import { ReadRuntimeRunStreamUseCase } from './application/use-cases/read-run-stream.use-case';
import { RunRuntimeAgainUseCase } from './application/use-cases/run-again.use-case';
import { SetTeamKeyRepositoriesUseCase } from './application/use-cases/set-team-key-repositories.use-case';
import { ClearRuntimeStopUseCase, StopRuntimeUseCase } from './application/use-cases/stop-runtime.use-case';
import {
    CreateRuntimeEnvironmentUseCase,
    GetRuntimeEnvironmentUseCase,
    ListEnvironmentBlockersUseCase,
    ListRuntimeEnvironmentsUseCase,
    ListEnvironmentStatusesUseCase,
    RequestEnvironmentSetupUseCase,
    EnvironmentViewBuilder,
    UpdateEnvironmentSettingsUseCase,
} from './application/use-cases/environments.use-cases';
import {
    GetRuntimeSettingsUseCase,
    GetRuntimeMachineMinutesUseCase,
    UpdateRuntimeMachineMinutesUseCase,
    UpdateRuntimeOrgSettingsUseCase,
    UpdateRuntimeRepositorySettingsUseCase,
} from './application/use-cases/settings.use-cases';
import {
    RUNTIME_AGENT_RUNNER_FACTORY,
    RUNTIME_API_CONFIG,
    RUNTIME_CELL_READER,
    RUNTIME_SANDBOX_CELL_FACTS_READER,
    RUNTIME_CELL_TOKEN_READER,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_LLM_PROVIDER,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_REPO_TOKEN_ISSUER,
    RUNTIME_LINKED_TASKS,
    RUNTIME_RELEASE_GATE,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_RUN_STREAM_STORE,
    RUNTIME_TEAM_REPOSITORIES,
    RUNTIME_SETTINGS_STORE,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_ENVIRONMENT_REPOSITORY_STORE,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_SUITE_BASELINE_READER,
    RUNTIME_SUITE_SHADOW_READER,
    RUNTIME_TEMPLATE_SETUP_READER,
    RUNTIME_BUILD_STATE_EVICTION_READER,
    RUNTIME_LESSON_READER,
    RUNTIME_ORG_REPOSITORIES,
    type RuntimeApiConfig,
    RUNTIME_EGRESS_READER,
    RUNTIME_CLAIM_USAGE_READER,
    RUNTIME_MACHINE_USAGE_READER,
    RUNTIME_FINDING_FEEDBACK_STORE,
    RUNTIME_FINDING_INTENT_STORE,
    RUNTIME_KEPT_CHECK_RESULTS_READER,
    RUNTIME_KEPT_CHECK_STORE,
    RUNTIME_LLM_SPEND_READER,
    RUNTIME_USAGE_REPORT_READER,
} from './domain/ports';
import {
    CodeManagementRuntimeGitAdapter,
    IntegrationConfigOrgRepositories,
    IntegrationConfigTeamRepositories,
} from './infrastructure/code-management-git.adapter';
import { PgRuntimeEgressReader } from './infrastructure/pg-runtime-egress.reader';
import { PgRuntimeClaimUsageReader } from './infrastructure/pg-runtime-claim-usage.reader';
import { PgRuntimeMachineUsageReader } from './infrastructure/pg-runtime-machine-usage.reader';
import { PgRuntimeRunStreamReader } from './infrastructure/pg-runtime-run-stream.reader';
import {
    RuntimeEnvironmentModel,
    RuntimeEnvironmentRepositoryModel,
    RuntimeFindingFeedbackModel,
    RuntimeFindingIntentModel,
    RuntimeKeptCheckModel,
    RuntimeRepositorySettingsModel,
    RuntimeSettingsModel,
} from './infrastructure/runtime-product.models';
import {
    TypeOrmEnvironmentRepositoryStore,
    TypeOrmFindingFeedbackStore,
    TypeOrmFindingIntentStore,
    TypeOrmProductEnvironmentStore,
    TypeOrmRuntimeSettingsStore,
} from './infrastructure/typeorm-runtime-product.stores';
import { TypeOrmRuntimeLlmBudgetStore } from './infrastructure/typeorm-llm-budget.store';
import { PgBuildStateEvictionReader, PgEnvironmentSetupReader, PgLessonReader, ProjectionEnvironmentReader, ReadOnlyRunProjectionStore } from './infrastructure/pg-runtime-readers';
import { PgRuntimeCellReader, PgRuntimeCellTokenReader, PgSandboxCellFactsReader } from './infrastructure/pg-runtime-cell.reader';
import { loadDashboardUrl, loadPushSetupConfig, loadRuntimeApiConfig, loadWebhookReconcilerConfig } from './infrastructure/runtime-api.config';
import { RuntimeReadDb } from './infrastructure/runtime-read-db';
import { RuntimeProductRetentionCron } from './infrastructure/runtime-product-retention.cron';
import { RuntimeWebhookReconciler } from './application/webhook-reconciler.service';
import { RUNTIME_RECONCILED_HEAD_STORE, RUNTIME_WEBHOOK_RECONCILER_CONFIG } from './domain/webhook-reconciler';
import { RUNTIME_PUSH_SETUP_CONFIG, RUNTIME_PUSH_SETUP_LEDGER } from './domain/push-setup';
import { TypeOrmPushSetupLedger } from './infrastructure/typeorm-push-setups.store';
import { TypeOrmReconciledHeadStore } from './infrastructure/typeorm-reconciled-heads.store';
import { TypeOrmSql } from './infrastructure/typeorm-sql';
import { RuntimeReaderAuthGuard } from './infrastructure/runtime-reader.guard';
import { ByokRuntimeAgentRunnerFactory, ByokRuntimeLlmProvider, permissionSlotResolver } from './infrastructure/byok-runtime-llm.provider';
import { CodeManagementRepoTokenIssuer } from './infrastructure/repo-token-issuer.adapter';
import { DevStubRepoTokenIssuer, DevStubRuntimeGit, devGitStubFile } from './infrastructure/dev-stub-git.adapter';
import { RUNTIME_PLATFORM_RESOLVER, RuntimeRunEnqueuer } from './application/runtime-run-enqueuer.service';
import { RuntimeDefaultBranchPushSetup } from './application/default-branch-push-setup.service';
import { RuntimeSetupRequester } from './application/runtime-setup-requester.service';
import { RuntimeEnvToolsService } from './application/env-tools.service';
import { ListRuntimeAuditUseCase } from './application/use-cases/env-audit.use-case';
import { RUNTIME_ENV_AUDIT_STORE, RUNTIME_ENV_SESSION_PORT } from './domain/env-tools';
import { HttpEnvSessionClient, loadEnvSessionClientConfig } from './infrastructure/http-env-session.client';
import { RUNTIME_PREVIEW_AUDIT_READER, RUNTIME_PREVIEW_PORT, RUNTIME_PREVIEW_SETTINGS_STORE } from './domain/previews';
import { RuntimePreviewSettingsUseCase } from './application/use-cases/preview-settings.use-cases';
import { PgRuntimePreviewAuditReader } from './infrastructure/pg-runtime-preview-audit.reader';
import { RuntimePreviewsService } from './application/use-cases/previews.use-cases';
import { TypeOrmRuntimeEnvAuditStore } from './infrastructure/typeorm-env-audit.store';
import { ExternalFindingsService } from './application/external-findings.service';
import { RUNTIME_EXTERNAL_FINDINGS, RUNTIME_EXTERNAL_FINDINGS_STORE, RUNTIME_EXTERNAL_STOP_READER } from './domain/external-findings';
import { RuntimeExternalSubmissionModel, RuntimeExternalMessageModel } from './infrastructure/runtime-external-finding.models';
import { TypeOrmExternalFindingsStore } from './infrastructure/typeorm-external-findings.store';
import { PgSuiteBaselineReader } from './infrastructure/pg-suite-baseline.reader';
import { PgSuiteShadowReader } from './infrastructure/pg-suite-shadow.reader';
import { PgSuiteReader } from './infrastructure/pg-suite.reader';
import { RUNTIME_SUITE_READER } from './domain/suite';
import { RuntimeSuiteRetrier } from './application/suite-retrier.service';
import { RuntimeSuiteSelection } from './application/suite-selection.service';
import { GetRuntimeEnvironmentSuiteUseCase, GetRuntimeRunSuiteArtifactUseCase, GetRuntimeRunSuiteUseCase, ResumeSuiteSelectionUseCase, RetryRuntimeRunSuiteUseCase } from './application/use-cases/suite.use-cases';
import { RuntimeSuiteShadowRequests } from './application/suite-shadow-requests.service';
import { PgTemplateSetupReader } from './infrastructure/pg-template-setup.reader';
import { RuntimeSuiteBaselineRequests } from './application/suite-baseline-requests.service';
import { RuntimeSuiteCiTrigger } from './application/suite-ci-trigger.service';
import { RuntimeSuiteInputs } from './application/suite-inputs.service';
import { RuntimeSuiteRequester } from './application/suite-requester.service';
import { RuntimeTemplateSetupRequests } from './application/template-setup-requests.service';
import { PgExternalStopReader } from './infrastructure/pg-external-stop.reader';
import { PgKeptCheckResultsReader } from './infrastructure/pg-kept-check-results.reader';
import { TypeOrmKeptCheckStore } from './infrastructure/typeorm-kept-checks.store';
import { RUNTIME_A2A_BASE_URL, RuntimeA2AAdapter } from './infrastructure/a2a/runtime-a2a.adapter';
import { RuntimeA2ABearerGuard } from './infrastructure/a2a/runtime-a2a.guard';
import {
    CreateRuntimeSecretUseCase,
    DeleteRuntimeSecretUseCase,
    ListRuntimeSecretAuditUseCase,
    ListRuntimeSecretsUseCase,
    UpdateRuntimeSecretUseCase,
} from './application/use-cases/secrets.use-cases';
import { RUNTIME_SECRET_STORE, RUNTIME_SECRET_VAULT } from './domain/secrets';
import { PurgeRuntimeOrganizationUseCase } from './application/use-cases/purge-organization.use-case';
import { RUNTIME_ORGANIZATION_PURGE_STORE } from './domain/organization-purge';
import { OrganizationDeletedPurgeListener } from './infrastructure/organization-deleted-purge.listener';
import { TypeOrmRuntimeOrganizationPurgeStore } from './infrastructure/typeorm-runtime-organization-purge.store';
import { loadOpenBaoSecretVaultConfig, OpenBaoSecretVault, UnconfiguredSecretVault } from './infrastructure/openbao-secret-vault.adapter';
import { TypeOrmRuntimeSecretStore } from './infrastructure/typeorm-runtime-secrets.store';

const useCases = [
    RuntimePreviewsService,
    RuntimePreviewSettingsUseCase,
    ListRuntimeRunsUseCase,
    GetRuntimeRunUseCase,
    ReadRuntimeRunStreamUseCase,
    GetRuntimeRunEvidenceUseCase,
    GetRuntimeRunReproductionUseCase,
    RunRuntimeAgainUseCase,
    GetRuntimeRunSuiteUseCase,
    RetryRuntimeRunSuiteUseCase,
    GetRuntimeRunSuiteArtifactUseCase,
    GetRuntimeEnvironmentSuiteUseCase,
    ResumeSuiteSelectionUseCase,
    ApproveForkRunUseCase,
    ApproveEgressUseCase,
    RevokeEgressUseCase,
    OrgEgressUseCases,
    RuntimeEgressAccess,
    StopRuntimeUseCase,
    ClearRuntimeStopUseCase,
    ListRuntimeEnvironmentsUseCase,
    ListEnvironmentStatusesUseCase,
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
    GetRuntimeMachineMinutesUseCase,
    UpdateRuntimeMachineMinutesUseCase,
    GetRuntimeUsageReportUseCase,
    GetRuntimeHealthUseCase,
    GetRuntimeSpeedUseCase,
    UpdateRuntimeOrgSettingsUseCase,
    UpdateRuntimeRepositorySettingsUseCase,
    CreateCellRegistrationTokenUseCase,
    ListCellRegistrationTokensUseCase,
    RevokeCellRegistrationTokenUseCase,
    ListRuntimeCellsUseCase,
    RevokeRuntimeCellUseCase,
    SetTeamKeyRepositoriesUseCase,
    RuntimeLlmGatewayUseCase,
    RuntimeRecipeAuthorUseCase,
    RuntimeSetupRepoTokensUseCase,
    RuntimeTestPlannerUseCase,
    RuntimeModelTurnGatewayUseCase,
    RuntimePlannerSourceUseCase,
    SetFindingFeedbackUseCase,
    SetFindingIntentUseCase,
    KeepRuntimeCheckUseCase,
    ListRuntimeKeptChecksUseCase,
    RemoveRuntimeKeptCheckUseCase,
    SimulateRuntimeRunUseCase,
    RuntimePullRequestTriggerUseCase,
    ListRuntimeAuditUseCase,
    ListPullRequestRunsUseCase,
    RequestPullRequestRunUseCase,
    EnvironmentRepositoriesUseCase,
    ListRuntimeSecretsUseCase,
    CreateRuntimeSecretUseCase,
    UpdateRuntimeSecretUseCase,
    DeleteRuntimeSecretUseCase,
    ListRuntimeSecretAuditUseCase,
    PurgeRuntimeOrganizationUseCase,
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
            RuntimeEnvironmentRepositoryModel,
            RuntimeSettingsModel,
            RuntimeRepositorySettingsModel,
            RuntimeFindingFeedbackModel,
            RuntimeFindingIntentModel,
            RuntimeKeptCheckModel,
            RuntimeRunTargetModel,
            RuntimeExternalSubmissionModel,
            RuntimeExternalMessageModel,
        ]),
        forwardRef(() => PermissionsModule),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => TeamModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => GithubModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => McpCoreModule),
    ],
    providers: [
        // The tasks a PR links, for the intent author: business validation's tracker reads, without its model.
        { provide: RUNTIME_LINKED_TASKS, useFactory: (mcp: MCPManagerService) => LinkedTasksAdapter.fromMcp(mcp), inject: [MCPManagerService] },
        // Kody Runtime is released by the org's release track (alpha): every entry point asks it.
        { provide: RUNTIME_RELEASE_GATE, useClass: ReleaseTrackRuntimeRelease },
        RuntimePoolController,
        RuntimePoolSchedulerCron,
        // A lost PR close: the sessions that hold its code are checked against the PR's state.
        {
            provide: RuntimePullRequestSessionSweep,
            inject: [RuntimeReadDb, RuntimeEnvironmentMembers, RuntimePullRequestTriggerUseCase],
            useFactory: (db: RuntimeReadDb, members: RuntimeEnvironmentMembers, trigger: RuntimePullRequestTriggerUseCase) =>
                new RuntimePullRequestSessionSweep(new PgPullRequestSessionsReader(db), members, trigger),
        },
        RuntimePullRequestSessionSweepCron,
        { provide: RUNTIME_API_CONFIG, useFactory: () => loadRuntimeApiConfig() },
        { provide: RUNTIME_CLOCK, useValue: () => new Date() },
        // The Run projection, the setups and the lessons: the Runtime Postgres, read-only (RUNTIME_DATABASE_READ_URL).
        {
            provide: RuntimeReadDb,
            inject: [RUNTIME_API_CONFIG],
            useFactory: (config: RuntimeApiConfig) => new RuntimeReadDb(config.runtimeDatabaseReadUrl),
        },
        {
            provide: RUNTIME_RUN_PROJECTION_STORE,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new ReadOnlyRunProjectionStore(db),
        },
        {
            provide: RUNTIME_PULL_REQUEST_RUNS_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgPullRequestRunsReader(db),
        },
        {
            provide: RUNTIME_ENVIRONMENT_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new ProjectionEnvironmentReader(db),
        },
        {
            provide: RUNTIME_ENVIRONMENT_SETUP_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgEnvironmentSetupReader(db),
        },
        {
            provide: RUNTIME_TEMPLATE_SETUP_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgTemplateSetupReader(db),
        },
        RuntimeTemplateSetupRequests,
        {
            provide: RUNTIME_SUITE_BASELINE_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgSuiteBaselineReader(db),
        },
        RuntimeSuiteBaselineRequests,
        {
            provide: RUNTIME_SUITE_SHADOW_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgSuiteShadowReader(db),
        },
        RuntimeSuiteShadowRequests,
        // The e2e suite's tables for the Run page, Settings and the usage report (read only, docs/runtime/e2e-suites.md section 13).
        {
            provide: RUNTIME_SUITE_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgSuiteReader(db, db.reports),
        },
        RuntimeSuiteRetrier,
        RuntimeSuiteSelection,
        RuntimeSuiteInputs,
        RuntimeSuiteRequester,
        RuntimeSuiteCiTrigger,
        {
            provide: RUNTIME_BUILD_STATE_EVICTION_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgBuildStateEvictionReader(db),
        },
        {
            provide: RUNTIME_LESSON_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgLessonReader(db),
        },
        // The product-side state below (receipts, call counts, budget, audit, publications): the product Postgres.
        { provide: TypeOrmSql, inject: [DataSource], useFactory: (source: DataSource) => new TypeOrmSql(source) },
        { provide: RUNTIME_SECRET_STORE, inject: [TypeOrmSql], useFactory: (sql: TypeOrmSql) => new TypeOrmRuntimeSecretStore(sql) },
        // Every product row of an org's Runtime data, for the org's purge (PurgeRuntimeOrganizationUseCase).
        { provide: RUNTIME_ORGANIZATION_PURGE_STORE, inject: [TypeOrmSql], useFactory: (sql: TypeOrmSql) => new TypeOrmRuntimeOrganizationPurgeStore(sql) },
        // Deletes the org's Runtime data when the product deletes the organization (libs/organization OrganizationService).
        OrganizationDeletedPurgeListener,
        {
            // The org secrets' store (docs/runtime/sandbox.md): OpenBao when RUNTIME_OPENBAO_ADDR is set, else none.
            provide: RUNTIME_SECRET_VAULT,
            useFactory: () => {
                const config = loadOpenBaoSecretVaultConfig();
                return config ? new OpenBaoSecretVault(config) : new UnconfiguredSecretVault();
            },
        },
        RuntimeProductRetentionCron,
        // The lost-webhook reconciler (docs/runtime/webhook-reconciler.md): only the product worker schedules it (RuntimeTriggerModule).
        { provide: RUNTIME_WEBHOOK_RECONCILER_CONFIG, useFactory: () => loadWebhookReconcilerConfig() },
        { provide: RUNTIME_RECONCILED_HEAD_STORE, inject: [TypeOrmSql], useFactory: (sql: TypeOrmSql) => new TypeOrmReconciledHeadStore(sql) },
        RuntimeWebhookReconciler,
        // A push to an environment's default branch sets it up again (R6): the ledger coalesces and budgets.
        { provide: RUNTIME_PUSH_SETUP_LEDGER, inject: [TypeOrmSql], useFactory: (sql: TypeOrmSql) => new TypeOrmPushSetupLedger(sql) },
        { provide: RUNTIME_PUSH_SETUP_CONFIG, useFactory: () => loadPushSetupConfig() },
        RuntimeDefaultBranchPushSetup,
        {
            provide: RUNTIME_RUN_STREAM_STORE,
            inject: [RUNTIME_API_CONFIG, RuntimeReadDb],
            // Postgres by default (read-only URL); the file volume only when RUNTIME_STREAM_STORE=file, or as the
            // cutover read of a Run written before the switch while RUNTIME_STREAM_DIR is still set.
            useFactory: (config: RuntimeApiConfig, db: RuntimeReadDb) =>
                config.streamStore === 'file'
                    ? new FileRunStreamStore(config.streamDir || '/tmp/kody-runtime-streams')
                    : new PgRuntimeRunStreamReader(db, config.streamDir ? new FileRunStreamStore(config.streamDir) : undefined),
        },
        {
            provide: RUNTIME_SANDBOX_CELL_FACTS_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgSandboxCellFactsReader(db),
        },
        {
            provide: RUNTIME_CELL_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgRuntimeCellReader(db),
        },
        {
            provide: RUNTIME_CELL_TOKEN_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgRuntimeCellTokenReader(db),
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
        { provide: RUNTIME_MODEL_TURN_RECEIPTS, inject: [TypeOrmSql], useFactory: (sql: TypeOrmSql) => new TypeOrmModelTurnReceipts(sql) },
        // A setup's calls asked again (a resumed workflow, an API restart): product state in the product Postgres, beside the budget.
        { provide: RUNTIME_RECIPE_AUTHOR_RECEIPTS, inject: [TypeOrmSql], useFactory: (sql: TypeOrmSql) => new TypeOrmRecipeAuthorReceipts(sql) },
        { provide: RUNTIME_SETUP_CALL_COUNTER, inject: [TypeOrmSql], useFactory: (sql: TypeOrmSql) => new TypeOrmSetupCallCounter(sql) },
        {
            // Kody's recipe author runs here on the same slot as the gateway; the worker never gets the key (ADR-057).
            provide: RUNTIME_AGENT_RUNNER_FACTORY,
            inject: [PermissionValidationService],
            useFactory: (svc: PermissionValidationService) => new ByokRuntimeAgentRunnerFactory(permissionSlotResolver(svc)),
        },
        {
            // The product Postgres, never the Runtime's: the budget is product state.
            provide: RUNTIME_LLM_USAGE_STORE,
            inject: [TypeOrmSql],
            useFactory: (sql: TypeOrmSql) => new TypeOrmRuntimeLlmBudgetStore(sql),
        },
        { provide: RUNTIME_TEAM_REPOSITORIES, useClass: IntegrationConfigTeamRepositories },
        { provide: RUNTIME_ORG_REPOSITORIES, useClass: IntegrationConfigOrgRepositories },
        TypeOrmRuntimeSettingsStore,
        { provide: RUNTIME_SETTINGS_STORE, useExisting: TypeOrmRuntimeSettingsStore },
        { provide: RUNTIME_PREVIEW_SETTINGS_STORE, useExisting: TypeOrmRuntimeSettingsStore },
        { provide: RUNTIME_PRODUCT_ENVIRONMENT_STORE, useClass: TypeOrmProductEnvironmentStore },
        { provide: RUNTIME_ENVIRONMENT_REPOSITORY_STORE, useClass: TypeOrmEnvironmentRepositoryStore },
        { provide: RUNTIME_FINDING_FEEDBACK_STORE, useClass: TypeOrmFindingFeedbackStore },
        { provide: RUNTIME_FINDING_INTENT_STORE, useClass: TypeOrmFindingIntentStore },
        // Kept checks (docs/runtime/kept-checks.md): the product's list, and each Run's outcomes read from the Runtime (read only).
        { provide: RUNTIME_KEPT_CHECK_STORE, useClass: TypeOrmKeptCheckStore },
        {
            provide: RUNTIME_KEPT_CHECK_RESULTS_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgKeptCheckResultsReader(db),
        },
        {
            provide: RUNTIME_EGRESS_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgRuntimeEgressReader(db),
        },
        EnvironmentViewBuilder,
        RuntimeRunAccessService,
        // The cost of a Run (§13 PR 5): its usage spans priced by the product's price list (as Token Usage),
        // and the machine time by what the Run's claims held (runtime_claims, read only).
        { provide: RUNTIME_LLM_SPEND_READER, useClass: TelemetryRuntimeLlmSpendReader },
        // The owner's usage report: a month of Runs and claims (read only, docs/runtime/usage-report.md).
        {
            provide: RUNTIME_USAGE_REPORT_READER,
            inject: [RuntimeReadDb],
            // Reads of up to 15 s: on the reports' pool, never holding the screens' connections (P5).
            // The Preview settings screen's month of preview claims stays on the screens' pool.
            useFactory: (db: RuntimeReadDb) => new PgRuntimeUsageReportReader(db.reports, db),
        },
        // Preview activity for the owner and the usage report (runtime_preview_audit, read only).
        {
            provide: RUNTIME_PREVIEW_AUDIT_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgRuntimePreviewAuditReader(db),
        },
        // The owner's Health screen (docs/runtime/observability.md): the same tables, org-scoped and bounded.
        {
            provide: RUNTIME_HEALTH_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgRuntimeHealthReader(db),
        },
        // The Health screen's Speed card: Runs of the window with their first probe and machine source, org-scoped and bounded.
        {
            provide: RUNTIME_SPEED_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgRuntimeSpeedReader(db.reports),
        },
        {
            provide: RUNTIME_CLAIM_USAGE_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgRuntimeClaimUsageReader(db),
        },
        // The org's machine minutes of today (runtime_machine_usage, read only), for the settings screen.
        {
            provide: RUNTIME_MACHINE_USAGE_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgRuntimeMachineUsageReader(db),
        },
        RuntimeRunCostService,
        { provide: RUNTIME_RUN_TARGET_STORE_TOKEN, useClass: TypeOrmRunTargetStore },
        {
            // What the product worker published on the PR (product Postgres, read only here): the Run page's source of truth.
            provide: RUNTIME_PUBLICATION_READER_TOKEN,
            inject: [TypeOrmSql],
            useFactory: (sql: TypeOrmSql) => new TypeOrmPublicationReader(sql),
        },
        IntegrationConfigRepositoryResolver,
        {
            // The trigger's answer to a `@kody runtime` that started no Run: one row of runtime_publications per PR, head and reason.
            provide: RUNTIME_SKIPPED_TRIGGER_REPLY_TOKEN,
            // A lost post is adopted only from a comment Kody itself wrote (review 2026-11-14, #11).
            inject: [TypeOrmSql, IntegrationConfigRepositoryResolver, CodeManagementService, GithubService],
            useFactory: (sql: TypeOrmSql, repositories: IntegrationConfigRepositoryResolver, codeManagement: CodeManagementService, github: GithubService) =>
                new SkippedTriggerReplyPublisher(
                    new TypeOrmPublicationStore(sql),
                    repositories,
                    codeManagement,
                    new PlatformCommentAuthor(codeManagement, () => github.getGithubAppId()),
                    // The same address the Run comment links to (runtime-publish.module.ts).
                    loadDashboardUrl(),
                ),
        },
        { provide: RUNTIME_PLATFORM_RESOLVER, useExisting: CodeManagementService },
        RuntimeRunEnqueuer,
        RuntimeRunRequestBuilder,
        RuntimeEnvironmentMembers,
        RuntimeSetupRequester,
        RuntimeReaderAuthGuard,
        // The /mcp/env tools (Inc. 1): the worker's env-session listener, and the env_exec audit in the product Postgres.
        { provide: RUNTIME_ENV_SESSION_PORT, useFactory: () => new HttpEnvSessionClient(loadEnvSessionClientConfig()) },
        // Preview URLs: the same signed listener of the worker (PREVIEW_ROUTES).
        { provide: RUNTIME_PREVIEW_PORT, useExisting: RUNTIME_ENV_SESSION_PORT },
        {
            provide: RUNTIME_ENV_AUDIT_STORE,
            inject: [TypeOrmSql],
            useFactory: (sql: TypeOrmSql) => new TypeOrmRuntimeEnvAuditStore(sql),
        },
        RuntimeEnvToolsService,
        {
            provide: RUNTIME_EXTERNAL_FINDINGS_STORE,
            inject: [DataSource, OUTBOX_MESSAGE_REPOSITORY_TOKEN],
            useFactory: (source: DataSource, outbox: IOutboxMessageRepository) => new TypeOrmExternalFindingsStore(source, outbox),
        },
        {
            provide: RUNTIME_EXTERNAL_STOP_READER,
            inject: [RuntimeReadDb],
            useFactory: (db: RuntimeReadDb) => new PgExternalStopReader(db),
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
    exports: [RUNTIME_RUN_PROJECTION_STORE, RUNTIME_SANDBOX_CELL_FACTS_READER, RUNTIME_RELEASE_GATE, RUNTIME_CLOCK, RUNTIME_WEBHOOK_RECONCILER_CONFIG, RuntimeWebhookReconciler, RuntimeDefaultBranchPushSetup, ...useCases, RuntimeReaderAuthGuard, RuntimeRunEnqueuer, RuntimeEnvToolsService, RuntimePoolController, RuntimeA2AAdapter, RuntimeA2ABearerGuard],
})
export class RuntimeApiModule {}
