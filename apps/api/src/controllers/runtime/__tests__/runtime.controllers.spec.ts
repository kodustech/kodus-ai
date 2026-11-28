import { CanActivate, ExecutionContext, INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import jwt = require('jsonwebtoken');
import passport = require('passport');
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';
import request = require('supertest');

import { OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { PERMISSIONS_SERVICE_TOKEN } from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { TEAM_CLI_KEY_SERVICE_TOKEN } from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { TEAM_SERVICE_TOKEN } from '@libs/organization/domain/team/contracts/team.service.contract';
import { RuntimeEnvironmentMembers } from '@libs/runtime/api/application/environment-members.service';
import { EnvironmentRepositoriesUseCase } from '@libs/runtime/api/application/use-cases/environment-repositories.use-cases';
import { ListPullRequestRunsUseCase } from '@libs/runtime/api/application/use-cases/pull-request-runs.use-case';
import { RequestPullRequestRunUseCase } from '@libs/runtime/api/application/use-cases/request-pull-request-run.use-case';
import { RUNTIME_ENVIRONMENT_REPOSITORY_STORE, RUNTIME_ENVIRONMENT_SETUP_READER } from '@libs/runtime/api/domain/ports';
import { RUNTIME_PULL_REQUEST_RUNS_READER } from '@libs/runtime/api/domain/pull-request-runs';
import { RuntimeRunAccessService } from '@libs/runtime/api/application/run-access.service';
import { RuntimeSuiteRetrier } from '@libs/runtime/api/application/suite-retrier.service';
import { RuntimeSuiteSelection } from '@libs/runtime/api/application/suite-selection.service';
import { GetRuntimeEnvironmentSuiteUseCase, GetRuntimeRunSuiteArtifactUseCase, GetRuntimeRunSuiteUseCase, ResumeSuiteSelectionUseCase, RetryRuntimeRunSuiteUseCase } from '@libs/runtime/api/application/use-cases/suite.use-cases';
import { RUNTIME_SUITE_READER } from '@libs/runtime/api/domain/suite';
import { suiteRunIdOfRun } from '@libs/runtime/contracts/derive-id';
import { RuntimeRunRequestBuilder } from '@libs/runtime/api/application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '@libs/runtime/api/application/runtime-run-enqueuer.service';
import { RuntimeSetupRequester } from '@libs/runtime/api/application/runtime-setup-requester.service';
import { ApplyBlockerFixUseCase } from '@libs/runtime/api/application/use-cases/apply-blocker-fix.use-case';
import { ProposeInferredRecipeUseCase } from '@libs/runtime/api/application/use-cases/propose-inferred-recipe.use-case';
import { ListEnvironmentLessonsUseCase, UpdateEnvironmentLessonUseCase } from '@libs/runtime/api/application/use-cases/lessons.use-cases';
import { RuntimeEgressAccess } from '@libs/runtime/api/application/egress-access.service';
import { ApproveEgressUseCase } from '@libs/runtime/api/application/use-cases/approve-egress.use-case';
import { OrgEgressUseCases, RevokeEgressUseCase } from '@libs/runtime/api/application/use-cases/egress-access.use-cases';
import { ApproveForkRunUseCase } from '@libs/runtime/api/application/use-cases/approve-fork-run.use-case';
import {
    CreateCellRegistrationTokenUseCase,
    ListCellRegistrationTokensUseCase,
    ListRuntimeCellsUseCase,
    RevokeCellRegistrationTokenUseCase,
    RevokeRuntimeCellUseCase,
} from '@libs/runtime/api/application/use-cases/cells.use-cases';
import { GetRuntimeRunEvidenceUseCase } from '@libs/runtime/api/application/use-cases/get-run-evidence.use-case';
import { RuntimePoolController } from '@libs/runtime/api/application/pool-controller.service';
import { GetRuntimeRunReproductionUseCase } from '@libs/runtime/api/application/use-cases/get-run-reproduction.use-case';
import { RuntimeRunCostService } from '@libs/runtime/api/application/run-cost.service';
import { GetRuntimeRunUseCase } from '@libs/runtime/api/application/use-cases/get-run.use-case';
import { SetFindingFeedbackUseCase } from '@libs/runtime/api/application/use-cases/finding-feedback.use-case';
import { SetFindingIntentUseCase } from '@libs/runtime/api/application/use-cases/finding-intent.use-case';
import { SimulateRuntimeRunUseCase } from '@libs/runtime/api/application/use-cases/simulate.use-case';
import { ListRuntimeRunsUseCase } from '@libs/runtime/api/application/use-cases/list-runs.use-case';
import { RuntimeLlmGatewayUseCase } from '@libs/runtime/api/application/use-cases/llm-gateway.use-case';
import { RuntimeRecipeAuthorUseCase } from '@libs/runtime/api/application/use-cases/recipe-author.use-case';
import { RuntimeTestPlannerUseCase } from '@libs/runtime/api/application/use-cases/test-planner.use-case';
import { ReadRuntimeRunStreamUseCase } from '@libs/runtime/api/application/use-cases/read-run-stream.use-case';
import { RunRuntimeAgainUseCase } from '@libs/runtime/api/application/use-cases/run-again.use-case';
import { SetTeamKeyRepositoriesUseCase } from '@libs/runtime/api/application/use-cases/set-team-key-repositories.use-case';
import { ClearRuntimeStopUseCase, StopRuntimeUseCase } from '@libs/runtime/api/application/use-cases/stop-runtime.use-case';
import { PurgeRuntimeOrganizationUseCase } from '@libs/runtime/api/application/use-cases/purge-organization.use-case';
import { RUNTIME_ORGANIZATION_PURGE_STORE } from '@libs/runtime/api/domain/organization-purge';
import { RUNTIME_SECRET_VAULT } from '@libs/runtime/api/domain/secrets';
import {
    CreateRuntimeEnvironmentUseCase,
    GetRuntimeEnvironmentUseCase,
    ListEnvironmentBlockersUseCase,
    ListRuntimeEnvironmentsUseCase,
    ListEnvironmentStatusesUseCase,
    RequestEnvironmentSetupUseCase,
    UpdateEnvironmentSettingsUseCase,
    RuntimeEnvironmentsReader,
} from '@libs/runtime/api/application/use-cases/environments.use-cases';
import {
    GetRuntimeMachineMinutesUseCase,
    UpdateRuntimeMachineMinutesUseCase,
    GetRuntimeSettingsUseCase,
    UpdateRuntimeOrgSettingsUseCase,
    UpdateRuntimeRepositorySettingsUseCase,
} from '@libs/runtime/api/application/use-cases/settings.use-cases';
import { GetRuntimeUsageReportUseCase } from '@libs/runtime/api/application/use-cases/usage-report.use-case';
import { GetRuntimeHealthUseCase } from '@libs/runtime/api/application/use-cases/runtime-health.use-case';
import { GetRuntimeSpeedUseCase } from '@libs/runtime/api/application/use-cases/runtime-speed.use-case';
import { RuntimePreviewSettingsUseCase } from '@libs/runtime/api/application/use-cases/preview-settings.use-cases';
import { RUNTIME_PREVIEW_SETTINGS_STORE } from '@libs/runtime/api/domain/previews';
import { DEFAULT_PREVIEW_SETTINGS } from '@libs/runtime/contracts/preview';
import { RUNTIME_HEALTH_READER } from '@libs/runtime/api/infrastructure/pg-runtime-health.reader';
import { RUNTIME_SPEED_READER } from '@libs/runtime/api/infrastructure/pg-runtime-speed.reader';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_LLM_SPEND_READER,
    RUNTIME_USAGE_REPORT_READER,
    RUNTIME_CELL_READER,
    RUNTIME_CELL_TOKEN_READER,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_LLM_PROVIDER,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_REPO_TOKEN_ISSUER,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_RUN_STREAM_STORE,
    RUNTIME_TEAM_REPOSITORIES,
    RUNTIME_EGRESS_READER,
    RUNTIME_MACHINE_USAGE_READER,
    RUNTIME_FINDING_FEEDBACK_STORE,
    RUNTIME_FINDING_INTENT_STORE,
    RUNTIME_ORG_REPOSITORIES,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RELEASE_GATE,
    RUNTIME_SETTINGS_STORE,
} from '@libs/runtime/api/domain/ports';
import { signRunToken, signSetupToken } from '@libs/runtime/api/domain/run-token';
import { RUNTIME_SETUP_CALL_COUNTER } from '@libs/runtime/api/domain/setup-calls';
import { RuntimeSetupRepoTokensUseCase } from '@libs/runtime/api/application/use-cases/setup-repo-tokens.use-case';
import { RuntimeReaderAuthGuard } from '@libs/runtime/api/infrastructure/runtime-reader.guard';
import {
    clock,
    config,
    FakeOutbox,
    InMemoryFindingFeedback,
    InMemoryFindingIntent,
    InMemoryLlmSpend,
    InMemoryLlmUsage,
    NOW,
    ORG,
    OTHER_ORG,
    OTHER_REPO,
    REPO,
    run,
    SECRET,
    storeWith,
    TEAM,
    user,
    InMemoryEnvironmentRepositories,
    spendRow,
    runtimeReleaseGate,
    InMemoryKeptCheckResults,
    InMemoryKeptChecks,
} from '@libs/runtime/api/__tests__/fixtures';

import { SetTeamCliKeyRepositoriesUseCase } from '../../../use-cases/set-team-cli-key-repositories.use-case';
import { RuntimeEnvironmentsController } from '../runtime-environments.controller';
import { RuntimeLlmGatewayController } from '../runtime-llm-gateway.controller';
import { RuntimeReleaseGuard } from '../runtime-release.guard';
import { RuntimeOncallGuard } from '../runtime-oncall.guard';
import { RuntimeOpsController } from '../runtime-ops.controller';
import { RuntimeOrgAdminController } from '../runtime-org-admin.controller';
import { RuntimePullRequestRunsController } from '../runtime-pull-request-runs.controller';
import { RuntimeRunsController } from '../runtime-runs.controller';
import { RuntimeKeptChecksController } from '../runtime-kept-checks.controller';
import { KeepRuntimeCheckUseCase, ListRuntimeKeptChecksUseCase, RemoveRuntimeKeptCheckUseCase } from '@libs/runtime/api/application/use-cases/kept-checks.use-cases';
import { RUNTIME_KEPT_CHECK_RESULTS_READER, RUNTIME_KEPT_CHECK_STORE } from '@libs/runtime/api/domain/ports';
import { RuntimeSettingsController } from '../runtime-settings.controller';
import { TeamCliKeyRepositoriesController } from '../team-cli-key-repositories.controller';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));

const JWT_SECRET = 'test-jwt-secret';
const USERS: Record<string, any> = {
    owner: user(Role.OWNER),
    repo_admin: user(Role.REPO_ADMIN),
    contributor: user(Role.CONTRIBUTOR),
    billing_manager: user(Role.BILLING_MANAGER),
    outsider: user(Role.OWNER, { org: OTHER_ORG, uuid: 'outsider' }),
    oncall: user(Role.OWNER, { uuid: 'oncall-1' }),
};

/** Stands in for the global JwtAuthGuard on PolicyGuard routes. */
@Injectable()
class InjectUserGuard implements CanActivate {
    canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const who = req.headers['x-test-user'];
        if (who) req.user = USERS[who];
        return true;
    }
}

const bearer = (who: string) => `Bearer ${jwt.sign({ sub: who }, JWT_SECRET)}`;

describe('Runtime controllers over HTTP', () => {
    let app: INestApplication;
    // The orgs Kody Runtime is released to (alpha track and flag); a test that takes one out puts it back.
    const releasedOrgs = new Set([ORG, OTHER_ORG]);
    const release = runtimeReleaseGate((org) => !!org && releasedOrgs.has(org));
    const live = run({ state: 'testing' });
    // A Run of a repository repo admins are not assigned to.
    const otherRepo = run({ repositoryId: OTHER_REPO, state: 'regression', probes: [{ probeId: 'p-other', entryPoint: 'GET /x', verdict: 'finding', reason: 'differs' }] } as never);
    const done = run({
        state: 'regression',
        probes: [{ probeId: 'empty-cart', entryPoint: 'POST /orders', verdict: 'finding', reason: 'status differs' }],
        reproduction: {
            probes: [
                {
                    probeId: 'empty-cart',
                    entryPoint: 'POST /orders',
                    purpose: 'An order with an empty cart is refused',
                    expected: '400',
                    spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'POST', path: '/orders', body: '{"items":[]}', timeoutMs: 5000 },
                    base: { status: 400 },
                    pr: { status: 500 },
                },
            ],
        },
    });
    const streams = new InMemoryRunStreamStore();
    const keptChecks = new InMemoryKeptChecks();
    const outbox = new FakeOutbox();
    const audit = { emit: jest.fn() };
    // The org's purge: the vault and the product rows are doubles; the use case has its own spec.
    const purged: { vault: string[]; rows: string[] } = { vault: [], rows: [] };
    const purgeStore = { secretIds: async () => ['db_password'], purgeOrganization: async (org: string) => (purged.rows.push(org), { runtime_environments: 2 }) };
    const purgeVault = { configured: true, delete: async (org: string, id: string) => void purged.vault.push(`${org}/${id}`) };
    const keyUpdates: any[] = [];
    // The recipe author's use case has its own spec; here only what the route hands it.
    const recipeAuthorCalls: Array<{ authorization?: string; body: any; signal?: AbortSignal }> = [];
    const recipeAuthor = {
        execute: (input: { authorization?: string; body: any; signal?: AbortSignal }) => {
            recipeAuthorCalls.push(input);
            const answer = { status: 'no_recipe', reason: 'nothing to boot', usage: { inputTokens: 1, outputTokens: 1 } };
            if (!input.body?.hang) return Promise.resolve(answer);
            return new Promise((resolve) => input.signal?.addEventListener('abort', () => resolve(answer)));
        },
    };

    beforeAll(async () => {
        process.env.RUNTIME_ONCALL_USER_IDS = 'oncall-1';
        passport.use(
            'jwt',
            new JwtStrategy({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: JWT_SECRET }, (payload: any, cb: any) =>
                cb(null, USERS[payload.sub] ?? false),
            ),
        );
        await streams.append(ORG, live.runId, { type: 'state', at: NOW.toISOString(), data: { state: 'testing' } });
        const store = await storeWith(live, done, otherRepo);

        const teamKeys = {
            validateKey: async (k: string) =>
                ({
                    kodus_reader: { keyId: 'k1', keyName: 'ci', team: { uuid: TEAM }, organization: { uuid: ORG }, config: { capabilities: ['runs:read'], repositoryIds: [REPO] } },
                    kodus_norepo: { keyId: 'k2', keyName: 'ci', team: { uuid: TEAM }, organization: { uuid: ORG }, config: { capabilities: ['runs:read'], repositoryIds: [] } },
                })[k] ?? null,
            findById: async (id: string) =>
                ({ k1: { uuid: 'k1', name: 'ci', team: { uuid: TEAM }, config: { capabilities: ['runs:read'] } } })[id] ?? undefined,
            update: async (_where: unknown, patch: any) => {
                keyUpdates.push(patch);
                return { uuid: 'k1', config: patch.config };
            },
        };

        const moduleRef = await Test.createTestingModule({
            controllers: [
                RuntimeRunsController,
                RuntimeKeptChecksController,
                RuntimeOrgAdminController,
                RuntimeOpsController,
                RuntimeEnvironmentsController,
                RuntimeSettingsController,
                RuntimeLlmGatewayController,
                TeamCliKeyRepositoriesController,
                RuntimePullRequestRunsController,
            ],
            providers: [
                PolicyGuard,
                RuntimeReleaseGuard,
                { provide: RUNTIME_RELEASE_GATE, useValue: release },
                PermissionsAbilityFactory,
                AuthorizationService,
                { provide: PERMISSIONS_SERVICE_TOKEN, useValue: { findOne: async () => ({ permissions: { assignedRepositoryIds: [REPO] } }) } },
                { provide: APP_GUARD, useClass: InjectUserGuard },
                { provide: RUNTIME_RUN_PROJECTION_STORE, useValue: store },
                { provide: RUNTIME_RUN_STREAM_STORE, useValue: streams },
                { provide: RUNTIME_LLM_USAGE_STORE, useValue: new InMemoryLlmUsage() },
                { provide: RUNTIME_API_CONFIG, useValue: config() },
                { provide: RUNTIME_CLOCK, useValue: clock },
                { provide: RUNTIME_CELL_READER, useValue: { listByOrganization: async () => [], listManaged: async () => [], get: async () => null } },
                { provide: RUNTIME_CELL_TOKEN_READER, useValue: { listByOrganization: async () => [], get: async () => null } },
                { provide: RUNTIME_ENVIRONMENT_READER, useValue: { get: async () => null } },
                { provide: RUNTIME_GIT_PORT, useValue: {} },
                { provide: RUNTIME_REPO_TOKEN_ISSUER, useValue: {} },
                { provide: RUNTIME_LLM_PROVIDER, useValue: { complete: async () => ({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }) } },
                { provide: RUNTIME_TEAM_REPOSITORIES, useValue: { listRepositoryIds: async () => [REPO] } },
                { provide: OUTBOX_MESSAGE_REPOSITORY_TOKEN, useValue: outbox },
                { provide: TEAM_CLI_KEY_SERVICE_TOKEN, useValue: teamKeys },
                { provide: TEAM_SERVICE_TOKEN, useValue: { findOneOrganizationIdByTeamId: async () => ORG } },
                RuntimeReaderAuthGuard,
                RuntimeOncallGuard,
                SetTeamCliKeyRepositoriesUseCase,
                { provide: EventEmitter2, useValue: audit },
                RuntimeRunAccessService,
                GetRuntimeRunSuiteUseCase,
                RetryRuntimeRunSuiteUseCase,
                GetRuntimeRunSuiteArtifactUseCase,
                GetRuntimeEnvironmentSuiteUseCase,
                ResumeSuiteSelectionUseCase,
                RuntimeSuiteSelection,
                { provide: RuntimeSuiteRetrier, useValue: { retryFailed: async () => ({ suiteRunId: 'retry-1' }) } },
                {
                    // One finished suite of the caller's org for the finished Run; nothing for any other Run or organization.
                    provide: RUNTIME_SUITE_READER,
                    useValue: {
                        get: async (org: string, id: string) =>
                            org === ORG && id === suiteRunIdOfRun(ORG, done.runId)
                                ? {
                                      run: { suiteRunId: id, organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, mode: 'run', state: 'failed', mainSha: 'd'.repeat(40), requestedAt: NOW.toISOString(), finishedAt: NOW.toISOString() },
                                      shards: [],
                                      results: [{ phase: 'shard', shard: 0, spec: 'a.spec.ts', status: 'failed', durationMs: 1, tests: [], artifacts: [] }],
                                  }
                                : null,
                        selectionState: async () => ({ off: false, fullPrsLeft: 0 }),
                        lastBaseline: async () => null,
                        lastBaselineRequest: async () => null,
                        lastMiss: async () => null,
                        usageOfMonth: async () => ({ rows: [], savings: null }),
                    },
                },
                RuntimeEnvironmentMembers,
                EnvironmentRepositoriesUseCase,
                { provide: RUNTIME_ENVIRONMENT_REPOSITORY_STORE, useValue: new InMemoryEnvironmentRepositories() },
                ListPullRequestRunsUseCase,
                RequestPullRequestRunUseCase,
                { provide: RUNTIME_PULL_REQUEST_RUNS_READER, useValue: { listForPullRequests: async () => [], setupStates: async () => new Map() } },
                { provide: RUNTIME_ENVIRONMENT_SETUP_READER, useValue: { get: async () => null } },
                RuntimeRunCostService,
                ListRuntimeRunsUseCase,
                GetRuntimeRunUseCase,
                ReadRuntimeRunStreamUseCase,
                GetRuntimeRunEvidenceUseCase,
                GetRuntimeRunReproductionUseCase,
                RuntimePoolController,
                RunRuntimeAgainUseCase,
                ApproveForkRunUseCase,
                ApproveEgressUseCase,
                RevokeEgressUseCase,
                OrgEgressUseCases,
                RuntimeEgressAccess,
                StopRuntimeUseCase,
                PurgeRuntimeOrganizationUseCase,
                { provide: RUNTIME_ORGANIZATION_PURGE_STORE, useValue: purgeStore },
                { provide: RUNTIME_SECRET_VAULT, useValue: purgeVault },
                CreateCellRegistrationTokenUseCase,
                ListCellRegistrationTokensUseCase,
                RevokeCellRegistrationTokenUseCase,
                ListRuntimeCellsUseCase,
                RevokeRuntimeCellUseCase,
                SetTeamKeyRepositoriesUseCase,
                RuntimeLlmGatewayUseCase,
                { provide: RuntimeRecipeAuthorUseCase, useValue: recipeAuthor },
                RuntimeSetupRepoTokensUseCase,
                { provide: RUNTIME_SETUP_CALL_COUNTER, useValue: { take: async () => true } },
                { provide: RuntimeTestPlannerUseCase, useValue: { execute: async () => { throw new Error('Planner route is not exercised in this fixture'); } } },
                ClearRuntimeStopUseCase,
                SetFindingFeedbackUseCase,
                SetFindingIntentUseCase,
                KeepRuntimeCheckUseCase,
                ListRuntimeKeptChecksUseCase,
                RemoveRuntimeKeptCheckUseCase,
                { provide: RUNTIME_KEPT_CHECK_STORE, useValue: keptChecks },
                { provide: RUNTIME_KEPT_CHECK_RESULTS_READER, useValue: new InMemoryKeptCheckResults() },
                SimulateRuntimeRunUseCase,
                { provide: RUNTIME_FINDING_FEEDBACK_STORE, useValue: new InMemoryFindingFeedback() },
                { provide: RUNTIME_FINDING_INTENT_STORE, useValue: new InMemoryFindingIntent() },
                { provide: RuntimeRunEnqueuer, useValue: { enqueue: async () => undefined } },
                { provide: RuntimeRunRequestBuilder, useValue: { build: async () => { throw new Error('not in these tests'); } } },
                RuntimeSetupRequester,
                RuntimeEnvironmentsReader,
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
                UpdateRuntimeOrgSettingsUseCase,
                UpdateRuntimeRepositorySettingsUseCase,
                {
                    provide: RUNTIME_PRODUCT_ENVIRONMENT_STORE,
                    useValue: { listByOrganization: async () => [], get: async () => null, findByRepository: async () => null, create: async () => null, markSetupRequested: async () => undefined, setDiagnosticHold: async () => undefined },
                },
                {
                    provide: RUNTIME_SETTINGS_STORE,
                    useValue: { getOrganization: async () => null, setTokenBudget: async () => undefined, setExercisedLinesThreshold: async () => undefined, setMachineUsdPerHostHour: async () => undefined, setPartlyTestedCheck: async () => undefined, listRepositories: async () => [], upsertRepository: async () => undefined },
                },
                { provide: RUNTIME_ORG_REPOSITORIES, useValue: { list: async () => ({ teamId: TEAM, repositories: [{ repositoryId: REPO, repositoryName: 'acme/shop' }] }) } },
                { provide: RUNTIME_EGRESS_READER, useValue: { blockedForRuns: async () => [], approvals: async () => [] } },
                GetRuntimeUsageReportUseCase,
                GetRuntimeHealthUseCase,
                GetRuntimeSpeedUseCase,
                {
                    // One Run that reached a verdict in the caller's org; nothing in any other org.
                    provide: RUNTIME_SPEED_READER,
                    useValue: {
                        speedRuns: async (org: string) =>
                            org === ORG
                                ? [{ runId: 'run-speed', environmentId: 'env-1', state: 'no_regressions', requestedAt: NOW.toISOString(), startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), firstProbeAt: {}, sideStarts: ['pool', 'pool'], sideOwners: ['kodus', 'kodus'] }]
                                : [],
                    },
                },
                RuntimePreviewSettingsUseCase,
                {
                    provide: RUNTIME_PREVIEW_SETTINGS_STORE,
                    useValue: { getPreviewSettings: async () => DEFAULT_PREVIEW_SETTINGS, setPreviewSettings: async () => undefined },
                },
                {
                    // One active setup in the caller's org; nothing in any other org.
                    provide: RUNTIME_HEALTH_READER,
                    useValue: {
                        setups: async (org: string) => (org === ORG ? [{ environmentId: 'env-1', organizationId: ORG, setupKey: 'setup:env-1', state: 'active', requestedAt: NOW.toISOString(), updatedAt: NOW.toISOString() }] : []),
                        runs: async () => [],
                        liveRuns: async () => [],
                        openClaims: async () => [],
                        blockers: async () => [],
                        cells: async () => [],
                        sessions: async () => [],
                    },
                },
                {
                    // One finished Run of this month in the caller's org; nothing in any other org.
                    provide: RUNTIME_USAGE_REPORT_READER,
                    useValue: {
                        runsOfMonth: async (org: string) =>
                            org === ORG
                                ? {
                                      total: 1,
                                      runs: [
                                          {
                                              runId: 'run-usage',
                                              organizationId: ORG,
                                              repositoryId: REPO,
                                              repositoryName: '=acme/shop',
                                              environmentId: 'env-1',
                                              prNumber: 7,
                                              trigger: 'pull_request',
                                              state: 'not_reproduced',
                                              verdictState: 'final',
                                              requestedAt: new Date(NOW.getTime() - 12 * 60_000).toISOString(),
                                              startedAt: null,
                                              bootingAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
                                              finishedAt: NOW.toISOString(),
                                              cellOwner: 'kodus',
                                              bootMs: 120_000,
                                              phaseMs: { boot: 90_000, apply: 30_000 },
                                              bootPhases: {},
                                              capacityWaitMs: null,
                                          },
                                      ],
                                  }
                                : { total: 0, runs: [] },
                        claimsOfMonth: async () => ({ claims: [], truncated: false }),
                        sandboxOperationsOfMonth: async () => ({ total: 0, refused: 0, failed: 0, durationMs: 0 }),
                    },
                },
                { provide: RUNTIME_LLM_SPEND_READER, useValue: new InMemoryLlmSpend([spendRow({ runId: 'run-usage', usd: 0.25 })]) },
                {
                    provide: RUNTIME_MACHINE_USAGE_READER,
                    useValue: { today: async (org: string) => (org === ORG ? { seconds: 90 * 60, heldSeconds: 30 * 60, openRounds: 1 } : { seconds: 0, heldSeconds: 0, openRounds: 0 }) },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        // The API's global pipe (apps/api/src/main.ts): the DTOs are part of the contract under test.
        app.useGlobalPipes(
            new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } }),
        );
        await app.init();
        // Listen on 127.0.0.1 before supertest does: its own listen(0) binds every interface and dials 127.0.0.1, where
        // another process on this machine may hold the same port and answer instead (a 404 or 401 from someone else).
        await app.listen(0, '127.0.0.1');
    });

    afterAll(async () => {
        passport.unuse('jwt');
        delete process.env.RUNTIME_ONCALL_USER_IDS;
        await app?.close();
    });

    const as = (who: string) => ({
        get: (p: string) => request(app.getHttpServer()).get(p).set('x-test-user', who),
        post: (p: string) => request(app.getHttpServer()).post(p).set('x-test-user', who),
        patch: (p: string) => request(app.getHttpServer()).patch(p).set('x-test-user', who),
        put: (p: string) => request(app.getHttpServer()).put(p).set('x-test-user', who),
        delete: (p: string) => request(app.getHttpServer()).delete(p).set('x-test-user', who),
    });

    it('an org Kody Runtime is not released to gets 404 on every Runtime route, a team key included; a released org is served', async () => {
        releasedOrgs.delete(ORG);
        try {
            await as('contributor').get('/runtime/environments').expect(404);
            await as('contributor').get('/runtime/settings').expect(404);
            await as('contributor').get('/runtime/runs').expect(404);
            await as('owner').post('/runtime/stop').send({}).expect(404);
            await as('contributor').post('/runtime/pull-request-runs').send({ pullRequests: [] }).expect(404);
            await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('x-team-key', 'kodus_reader').expect(404);
        } finally {
            releasedOrgs.add(ORG);
        }
        await as('contributor').get('/runtime/environments').expect(200);
        await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('x-team-key', 'kodus_reader').expect(200);
    });

    it('environment reads: readers of the org, another org is 404, billing is 403', async () => {
        const list = await as('contributor').get('/runtime/environments').expect(200);
        expect(list.body.map((e: any) => e.environmentId)).toEqual(['env-1']);
        await as('contributor').get('/runtime/environments/env-1').expect(200);
        expect((await as('contributor').get('/runtime/environments/env-1/blockers').expect(200)).body).toEqual([]);
        await as('outsider').get('/runtime/environments/env-1').expect(404);
        await as('outsider').get('/runtime/environments/env-1/blockers').expect(404);
        await as('billing_manager').get('/runtime/environments').expect(403);
        // The status a screen polls is its own route, not an environment called "status".
        expect((await as('contributor').get('/runtime/environments/status').expect(200)).body).toEqual([]);
        await as('billing_manager').get('/runtime/environments/status').expect(403);
    });

    it('settings: read by settings readers, budget by the org admin, repo by its admins', async () => {
        const res = await as('contributor').get('/runtime/settings').expect(200);
        expect(res.body).toEqual({
            tokenBudgetPerDay: null,
            exercisedLinesThresholdPercent: null,
            exercisedLinesThresholdDefaultPercent: 50,
            machineUsdPerHostHour: null,
            partlyTestedCheck: null,
            repositories: [
                {
                    repositoryId: REPO,
                    repositoryName: 'acme/shop',
                    pilot: false,
                    whoCanAsk: 'writers',
                    mode: 'off',
                    rules: [],
                    runOnAgentPullRequests: false,
                    runOnNewPushes: false,
                },
            ],
        });
        await as('repo_admin').patch('/runtime/settings').send({ tokenBudgetPerDay: 10 }).expect(403);
        await as('owner').patch('/runtime/settings').send({ tokenBudgetPerDay: 10 }).expect(200);
        await as('owner').patch('/runtime/settings').send({ tokenBudgetPerDay: -1 }).expect(400);
        // The exercised-lines threshold is the org admin's too, alone or with the budget.
        await as('repo_admin').patch('/runtime/settings').send({ exercisedLinesThresholdPercent: 30 }).expect(403);
        await as('owner').patch('/runtime/settings').send({ exercisedLinesThresholdPercent: 30 }).expect(200);
        await as('owner').patch('/runtime/settings').send({ exercisedLinesThresholdPercent: 0 }).expect(200);
        await as('owner').patch('/runtime/settings').send({ exercisedLinesThresholdPercent: null }).expect(200);
        await as('owner').patch('/runtime/settings').send({ tokenBudgetPerDay: 10, exercisedLinesThresholdPercent: 30 }).expect(200);
        await as('owner').patch('/runtime/settings').send({ exercisedLinesThresholdPercent: 101 }).expect(400);
        await as('owner').patch('/runtime/settings').send({ exercisedLinesThresholdPercent: 12.5 }).expect(400);
        // The price per host-hour of the org's own hosts is the org admin's too: a positive US$ up to 1 000, or null.
        await as('repo_admin').patch('/runtime/settings').send({ machineUsdPerHostHour: 0.2 }).expect(403);
        await as('owner').patch('/runtime/settings').send({ machineUsdPerHostHour: 0.1344 }).expect(200);
        await as('owner').patch('/runtime/settings').send({ machineUsdPerHostHour: null }).expect(200);
        for (const bad of [0, -1, 1_001, '0.2']) await as('owner').patch('/runtime/settings').send({ machineUsdPerHostHour: bad }).expect(400);
        await as('contributor').put(`/runtime/settings/repositories/${REPO}`).send({ whoCanAsk: 'writers' }).expect(403);
        await as('repo_admin').put(`/runtime/settings/repositories/${REPO}`).send({ whoCanAsk: 'maintainers' }).expect(200);
        await as('owner').put('/runtime/settings/repositories/repo-unknown').send({ whoCanAsk: 'maintainers' }).expect(404);
    });

    it("machine minutes of today: settings readers see their own org's count only, no session is refused", async () => {
        const mine = await as('contributor').get('/runtime/settings/machine-minutes').expect(200);
        expect(mine.body).toMatchObject({ committedMinutes: 90, usedMinutes: 30, openRounds: 1 });
        const other = await as('outsider').get('/runtime/settings/machine-minutes').expect(200);
        expect(other.body).toMatchObject({ committedMinutes: 0, usedMinutes: 0, openRounds: 0 });
        const anonymous = await request(app.getHttpServer()).get('/runtime/settings/machine-minutes');
        expect([401, 403]).toContain(anonymous.status);
    });

    it("the org's own daily machine minutes: the org admin sets them for the caller's org only, a bad value is 400", async () => {
        const before = outbox.rows.length;
        await as('repo_admin').patch('/runtime/settings/machine-minutes').send({ minutesPerDay: 600 }).expect(403);
        await as('contributor').patch('/runtime/settings/machine-minutes').send({ minutesPerDay: 600 }).expect(403);
        await as('owner').patch('/runtime/settings/machine-minutes').send({ minutesPerDay: 0 }).expect(400);
        await as('owner').patch('/runtime/settings/machine-minutes').send({ minutesPerDay: '600' }).expect(400);
        expect((await as('owner').patch('/runtime/settings/machine-minutes').send({ minutesPerDay: 600 }).expect(200)).body).toMatchObject({ minutesPerDay: 600 });
        await as('owner').patch('/runtime/settings/machine-minutes').send({ minutesPerDay: null }).expect(200);
        const sent = outbox.rows.slice(before).map((r) => r.payload);
        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({ event_name: 'runtime.org.machine_minutes_changed', payload: { organizationId: ORG, minutesPerDay: 600 } });
        expect(sent[1]).toMatchObject({ payload: { organizationId: ORG, minutesPerDay: null } });
    });

    it("usage report: the org owner only, of the caller's org, as JSON and as CSV", async () => {
        const month = `${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, '0')}`;
        const mine = await as('owner').get(`/runtime/settings/usage?month=${month}`).expect(200);
        expect(mine.body).toMatchObject({ month, counts: { runs: 1, runsListed: 1 }, llm: { source: 'telemetry' } });
        expect(mine.body.runs[0]).toMatchObject({ runId: 'run-usage', wallMinutes: 12, llm: { usd: 0.25 } });
        for (const who of ['repo_admin', 'contributor', 'billing_manager']) await as(who).get('/runtime/settings/usage').expect(403);
        expect((await as('outsider').get('/runtime/settings/usage').expect(200)).body.counts.runs).toBe(0);
        await as('owner').get('/runtime/settings/usage?month=2026-13').expect(400);

        const csv = await as('owner').get(`/runtime/settings/usage/export?month=${month}`).expect(200);
        expect(csv.headers['content-type']).toMatch(/^text\/csv/);
        expect(csv.headers['content-disposition']).toBe(`attachment; filename="kody-runtime-usage-${month}.csv"`);
        const [header, line] = csv.text.split('\r\n');
        expect(header.split(',').slice(0, 4)).toEqual(['run_id', 'requested_at', 'finished_at', 'repository']);
        // A repository name a spreadsheet would run as a formula is written as text.
        expect(line.split(',')[3]).toBe("'=acme/shop");
        await as('contributor').get('/runtime/settings/usage/export').expect(403);
    });

    it("health: the org owner only, of the caller's org", async () => {
        const mine = await as('owner').get('/runtime/settings/health').expect(200);
        // The fixture's product lists no environment, so the setup the Runtime holds is not counted (runtime-health.spec.ts).
        expect(mine.body).toMatchObject({ organizationId: ORG, summary: { setups: { measured: true, active: 0, blocked: 0, settingUp: 0 } } });
        for (const who of ['repo_admin', 'contributor', 'billing_manager']) await as(who).get('/runtime/settings/health').expect(403);
        expect((await as('outsider').get('/runtime/settings/health').expect(200)).body.organizationId).toBe(OTHER_ORG);
    });

    it("health speed: the org owner only, of the caller's org, over 7 or 30 days", async () => {
        const mine = await as('owner').get('/runtime/settings/health/speed?windowDays=30').expect(200);
        expect(mine.body).toMatchObject({ windowDays: 30, considered: 1, counted: 1, all: { verdict: { n: 1, tooFew: true, p50Ms: null } } });
        await as('owner').get('/runtime/settings/health/speed?windowDays=90').expect(400);
        for (const who of ['repo_admin', 'contributor', 'billing_manager']) await as(who).get('/runtime/settings/health/speed').expect(403);
        expect((await as('outsider').get('/runtime/settings/health/speed').expect(200)).body).toMatchObject({ windowDays: 7, considered: 0 });
    });

    it('feedback per tested path: any reader of the Run votes once, another org is 404', async () => {
        const path = `/runtime/runs/${done.runId}/findings/empty-cart/feedback`;
        expect((await as('contributor').put(path).send({ value: 'up' }).expect(200)).body).toEqual({ up: 1, down: 0, mine: 'up' });
        expect((await as('owner').put(path).send({ value: 'down' }).expect(200)).body).toEqual({ up: 1, down: 1, mine: 'down' });
        expect((await as('contributor').get(`/runtime/runs/${done.runId}`).expect(200)).body.feedback).toEqual({
            'empty-cart': { up: 1, down: 1, mine: 'up' },
        });
        expect((await as('contributor').put(path).send({ value: null }).expect(200)).body).toEqual({ up: 0, down: 1 });
        await as('contributor').put(path).send({ value: 'meh' }).expect(400);
        await as('contributor').put(`/runtime/runs/${done.runId}/findings/not-tested/feedback`).send({ value: 'up' }).expect(404);
        await as('outsider').put(path).send({ value: 'up' }).expect(404);
        await as('billing_manager').put(path).send({ value: 'up' }).expect(403);
    });

    it('marks a finding intended and clears it: write on Runs, findings of this Run only, the check unchanged', async () => {
        const path = `/runtime/runs/${done.runId}/findings/empty-cart/intent`;
        const before = (await as('owner').get(`/runtime/runs/${done.runId}`).expect(200)).body;
        expect(before.intendedBy).toEqual({});
        const marked = (await as('repo_admin').put(path).send({ intended: true }).expect(200)).body;
        expect(marked).toMatchObject({ intended: true, mine: true, at: expect.any(String) });
        const after = (await as('owner').get(`/runtime/runs/${done.runId}`).expect(200)).body;
        expect(after.intendedBy['empty-cart']).toMatchObject({ userId: USERS.repo_admin.uuid, mine: false });
        // A learning signal: the verdict and the check stay what Kody measured.
        expect(after.check).toEqual(before.check);
        expect(after.state).toBe(before.state);
        expect(after.probes).toEqual(before.probes);
        expect((await as('owner').put(path).send({ intended: false }).expect(200)).body).toEqual({ intended: false });
        expect((await as('owner').get(`/runtime/runs/${done.runId}`).expect(200)).body.intendedBy).toEqual({});
        await as('owner').put(path).send({ intended: 'yes' }).expect(400);
        await as('owner').put(`/runtime/runs/${done.runId}/findings/not-tested/intent`).send({ intended: true }).expect(404);
        await as('contributor').put(path).send({ intended: true }).expect(403);
        await as('outsider').put(path).send({ intended: true }).expect(404);
        // Write on Runs of one repository is not write on another's (S1-WEB-04): repo admins hold REPO only.
        await as('repo_admin').put(`/runtime/runs/${otherRepo.runId}/findings/p-other/intent`).send({ intended: true }).expect(403);
        await as('owner').put(`/runtime/runs/${otherRepo.runId}/findings/p-other/intent`).send({ intended: true }).expect(200);
    });

    it('kept checks: kept and removed like "Run again", listed by readers of the environment, another org 404, unreleased 404', async () => {
        await as('contributor').post('/runtime/kept-checks').send({ runId: done.runId, probeId: 'empty-cart' }).expect(403);
        await as('outsider').post('/runtime/kept-checks').send({ runId: done.runId, probeId: 'empty-cart' }).expect(404);
        await as('owner').post('/runtime/kept-checks').send({ runId: done.runId }).expect(400);
        const kept = (await as('repo_admin').post('/runtime/kept-checks').send({ runId: done.runId, probeId: 'empty-cart' }).expect(201)).body;
        expect(kept).toMatchObject({ created: true, check: { kind: 'http', exercised: 'POST /orders', source: { runId: done.runId, probeId: 'empty-cart' } } });
        expect((await as('owner').post('/runtime/kept-checks').send({ runId: done.runId, probeId: 'empty-cart' }).expect(201)).body.created).toBe(false);
        const listed = (await as('contributor').get('/runtime/kept-checks?environmentId=env-1').expect(200)).body;
        expect(listed.checks.map((c: any) => c.keptCheckId)).toEqual([kept.check.keptCheckId]);
        await as('outsider').get('/runtime/kept-checks?environmentId=env-1').expect(404);
        await as('billing_manager').get('/runtime/kept-checks?environmentId=env-1').expect(403);
        releasedOrgs.delete(ORG);
        try {
            await as('owner').get('/runtime/kept-checks?environmentId=env-1').expect(404);
            await as('owner').post('/runtime/kept-checks').send({ runId: done.runId, probeId: 'empty-cart' }).expect(404);
            await as('owner').delete(`/runtime/kept-checks/${kept.check.keptCheckId}`).expect(404);
        } finally {
            releasedOrgs.add(ORG);
        }
        await as('contributor').delete(`/runtime/kept-checks/${kept.check.keptCheckId}`).expect(403);
        await as('outsider').delete(`/runtime/kept-checks/${kept.check.keptCheckId}`).expect(404);
        expect((await as('repo_admin').delete(`/runtime/kept-checks/${kept.check.keptCheckId}`).expect(200)).body).toEqual({ removed: true });
        expect((await as('owner').get('/runtime/kept-checks?environmentId=env-1').expect(200)).body.checks).toEqual([]);
    });

    it('GET /runtime/runs filters by PR inside a repository', async () => {
        expect((await as('contributor').get(`/runtime/runs?repositoryId=${REPO}&prNumber=7`).expect(200)).body).toHaveLength(2);
        expect((await as('contributor').get(`/runtime/runs?repositoryId=${REPO}&prNumber=8`).expect(200)).body).toEqual([]);
        await as('contributor').get('/runtime/runs?prNumber=7').expect(400);
    });

    it('GET /runtime/runs/:id/suite: any reader of the org, another org\'s Run and a Run with no suite are 404', async () => {
        const res = await as('contributor').get(`/runtime/runs/${done.runId}/suite`).expect(200);
        expect(res.body).toMatchObject({ suiteRunId: suiteRunIdOfRun(ORG, done.runId), state: 'failed', canRetry: true });
        await as('outsider').get(`/runtime/runs/${done.runId}/suite`).expect(404);
        await as('contributor').get(`/runtime/runs/${live.runId}/suite`).expect(404);
        await as('billing_manager').get(`/runtime/runs/${done.runId}/suite`).expect(403);
    });

    it('POST /runtime/runs/:id/suite/retry: who may run the Run again, 202 with the retry\'s id, another org\'s Run is 404', async () => {
        await as('contributor').post(`/runtime/runs/${done.runId}/suite/retry`).send({}).expect(403);
        await as('repo_admin').post(`/runtime/runs/${otherRepo.runId}/suite/retry`).send({}).expect(403);
        await as('outsider').post(`/runtime/runs/${done.runId}/suite/retry`).send({}).expect(404);
        const res = await as('owner').post(`/runtime/runs/${done.runId}/suite/retry`).send({}).expect(202);
        expect(res.body).toEqual({ suiteRunId: 'retry-1', state: 'queued' });
    });

    it('GET /runtime/runs/:id/suite/artifacts: names the spec and the file, never a key', async () => {
        await as('owner').get(`/runtime/runs/${done.runId}/suite/artifacts`).expect(400);
        await as('owner').get(`/runtime/runs/${done.runId}/suite/artifacts?spec=a.spec.ts&name=trace.zip`).expect(404);
        await as('outsider').get(`/runtime/runs/${done.runId}/suite/artifacts?spec=a.spec.ts&name=trace.zip`).expect(404);
    });

    it('GET /runtime/environments/:id/suite and POST .../suite/selection/resume: readers read, only who manages the environment resumes, unknown is 404', async () => {
        await as('contributor').get('/runtime/environments/env-x/suite').expect(404);
        await as('billing_manager').get('/runtime/environments/env-x/suite').expect(403);
        await as('contributor').post('/runtime/environments/env-x/suite/selection/resume').send({}).expect(403);
        await as('repo_admin').post('/runtime/environments/env-x/suite/selection/resume').send({}).expect(403);
        await as('owner').post('/runtime/environments/env-x/suite/selection/resume').send({}).expect(404);
        await as('owner').patch('/runtime/environments/env-x/settings').send({ suiteCi: 'sometimes' }).expect(400);
        await as('owner').patch('/runtime/environments/env-x/settings').send({ suiteCi: true, suiteSelection: false }).expect(404);
    });

    it('POST /runtime/environments/:id/simulate: repo admins only, unknown environment is 404', async () => {
        await as('contributor').post('/runtime/environments/env-1/simulate').send({ prNumber: 3 }).expect(403);
        await as('repo_admin').post('/runtime/environments/env-1/simulate').send({ prNumber: 3 }).expect(404);
        await as('repo_admin').post('/runtime/environments/env-1/simulate').send({ prNumber: 'x' }).expect(400);
    });

    it('POST /runtime/stop/clear follows the stop rules', async () => {
        await as('repo_admin').post('/runtime/stop/clear').send({ scope: 'org' }).expect(403);
        await as('owner').post('/runtime/stop/clear').send({ scope: 'global' }).expect(400);
        await as('owner').post('/runtime/stop/clear').send({ scope: 'org' }).expect(202);
        expect(outbox.events).toContain('runtime.stop.cleared');
    });

    it('GET /runtime/runs: readers of the org see its Runs, billing is 403', async () => {
        for (const who of ['owner', 'repo_admin', 'contributor']) {
            const res = await as(who).get('/runtime/runs').expect(200);
            // Reading Runs is org-wide for these roles: the other repository's Run too.
            expect(res.body.map((r: any) => r.runId).sort()).toEqual([live.runId, done.runId, otherRepo.runId].sort());
        }
        await as('billing_manager').get('/runtime/runs').expect(403);
        expect((await as('outsider').get('/runtime/runs').expect(200)).body).toEqual([]);
    });

    it('GET /runtime/runs/:id answers 404 to another org', async () => {
        await as('contributor').get(`/runtime/runs/${done.runId}`).expect(200);
        await as('outsider').get(`/runtime/runs/${done.runId}`).expect(404);
    });

    it('GET /runtime/runs/:id/findings/:probeId/reproduce returns reproduction data, never host-executable script', async () => {
        const detail = (await as('contributor').get(`/runtime/runs/${done.runId}`).expect(200)).body;
        expect(detail.reproducible).toEqual(['empty-cart']);
        expect(detail.reproduction).toBeUndefined();
        const res = await as('contributor').get(`/runtime/runs/${done.runId}/findings/empty-cart/reproduce`).expect(200);
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(res.body.filename).toBe('kody-repro-pr7-empty-cart.json');
        expect(res.body).not.toHaveProperty('script');
        expect(res.body.manifest).toMatchObject({
            schemaVersion: 1,
            kind: 'kodus.runtime.reproduction',
            run: { runId: done.runId, baseSha: done.baseSha, headSha: done.headSha, prNumber: 7 },
            probe: { probeId: 'empty-cart', spec: { kind: 'http', body: '{"items":[]}' } },
        });
        expect(res.body.manifest).not.toHaveProperty('boot');
        await as('contributor').get(`/runtime/runs/${done.runId}/findings/other/reproduce`).expect(404);
        await as('contributor').get(`/runtime/runs/${live.runId}/findings/empty-cart/reproduce`).expect(404);
        await as('outsider').get(`/runtime/runs/${done.runId}/findings/empty-cart/reproduce`).expect(404);
        await as('billing_manager').get(`/runtime/runs/${done.runId}/findings/empty-cart/reproduce`).expect(403);
    });

    it('GET /runtime/runs/:id/stream serves Durable Streams headers to a JWT user', async () => {
        const res = await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('authorization', bearer('contributor')).expect(200);
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(res.headers['stream-up-to-date']).toBe('true');
        expect(res.headers['stream-next-offset']).toBeTruthy();
        expect(res.body).toEqual([{ type: 'state', at: NOW.toISOString(), data: { state: 'testing' } }]);

        const again = await request(app.getHttpServer())
            .get(`/runtime/runs/${live.runId}/stream?offset=${res.headers['stream-next-offset']}&live=long-poll`)
            .set('authorization', bearer('contributor'))
            .expect(204);
        expect(again.headers['stream-next-offset']).toBe(res.headers['stream-next-offset']);
    });

    it('GET /runtime/runs/:id/stream accepts a team key with runs:read on the repo only', async () => {
        await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('x-team-key', 'kodus_reader').expect(200);
        await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('authorization', 'Bearer kodus_reader').expect(200);
        await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('x-team-key', 'kodus_norepo').expect(403);
        await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('x-team-key', 'kodus_revoked').expect(401);
        await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).expect(401);
        await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('authorization', bearer('outsider')).expect(404);
        await request(app.getHttpServer()).get(`/runtime/runs/${live.runId}/stream`).set('authorization', bearer('billing_manager')).expect(403);
    });

    it("POST /runtime/organization-data/purge: the owner of the org who types the org id; the confirmation and the role are checked first", async () => {
        const before = outbox.events.length;
        const purge = (who: string, body: unknown) => as(who).post('/runtime/organization-data/purge').send(body as object);
        // Not the owner: refused before anything is touched.
        for (const who of ['repo_admin', 'contributor', 'billing_manager']) await purge(who, { confirm: ORG }).expect(403);
        // The owner, with no confirmation, the wrong one, another org's id, or one that is not a string.
        await purge('owner', {}).expect(400);
        await purge('owner', { confirm: '' }).expect(400);
        await purge('owner', { confirm: 'org-nobody' }).expect(400);
        await purge('owner', { confirm: OTHER_ORG }).expect(400);
        await purge('owner', { confirm: [ORG] }).expect(400);
        await purge('owner', { confirm: ORG, extra: true }).expect(400);
        expect(purged).toEqual({ vault: [], rows: [] });
        expect(outbox.events.slice(before)).toEqual([]);

        // The owner's own org id: the secrets leave the vault, the product rows go, the Runtime is told.
        const res = await purge('owner', { confirm: ORG }).expect(202);
        expect(res.body).toMatchObject({ organizationId: ORG, secretsDeleted: 1, productRows: 2 });
        expect(purged).toEqual({ vault: [`${ORG}/db_password`], rows: [ORG] });
        expect(outbox.events.slice(before)).toEqual(['runtime.organization.purge_requested']);
        expect(outbox.rows.at(-1)!.payload).toMatchObject({ payload: { organizationId: ORG, reason: 'owner_requested', requestedBy: { userId: expect.any(String) } } });
        // An owner of another org purges that org, never this one.
        await as('outsider').post('/runtime/organization-data/purge').send({ confirm: ORG }).expect(400);
    });

    it('org-admin routes are owner-only', async () => {
        await as('repo_admin').post('/runtime/stop').send({ scope: 'org' }).expect(403);
        await as('owner').post('/runtime/stop').send({ scope: 'org' }).expect(202);
        // The global stop is not a tenant route: the org route takes 'org' only.
        await as('owner').post('/runtime/stop').send({ scope: 'global' }).expect(400);
        await as('oncall').post('/runtime/stop').send({ scope: 'global' }).expect(400);
        await as('contributor').post('/runtime/cells/registration-tokens').send({ topology: 'hybrid' }).expect(403);
        const token = await as('owner').post('/runtime/cells/registration-tokens').send({ topology: 'hybrid' }).expect(201);
        expect(token.body.token).toMatch(/^kcr_/);
        await as('repo_admin').get('/runtime/cells').expect(403);
        await as('owner').post('/runtime/cells/nope/revoke').send({}).expect(404);
        // Tokens: listed and revoked by the owner only; an unknown one is 404.
        await as('repo_admin').get('/runtime/cells/registration-tokens').expect(403);
        await as('owner').get('/runtime/cells/registration-tokens').expect(200);
        await as('contributor').post(`/runtime/cells/registration-tokens/${token.body.id}/revoke`).expect(403);
        await as('owner').post(`/runtime/cells/registration-tokens/${token.body.id}/revoke`).expect(404);
        await as('owner').post('/runtime/environments/env-x/egress-approvals').send({ host: 'registry.example.com' }).expect(404);
        // A repo admin reaches the use case (D3: the org may let them add hosts) and meets the same 404.
        await as('repo_admin').post('/runtime/environments/env-x/egress-approvals').send({ host: 'registry.example.com' }).expect(404);
        await as('contributor').post('/runtime/environments/env-x/egress-approvals').send({ host: 'registry.example.com' }).expect(403);
        await as('owner').delete('/runtime/environments/env-x/egress-approvals/registry.example.com').send({}).expect(404);
        await as('contributor').delete('/runtime/environments/env-x/egress-approvals/registry.example.com').send({}).expect(403);
        // The org's outbound access: read by environment readers, changed by the owner only.
        await as('contributor').get('/runtime/egress').expect(200);
        await as('repo_admin').get('/runtime/egress').expect(200);
        await as('billing_manager').get('/runtime/egress').expect(403);
        await as('repo_admin').put('/runtime/egress/settings').send({ recommendedEnabled: false }).expect(403);
        await as('owner').put('/runtime/egress/settings').send({ recommendedEnabled: false }).expect(202);
        await as('owner').put('/runtime/egress/settings').send({ whoMayAdd: 'everyone' }).expect(400);
        // The diagnostic hold is the org admin's (Manage on RuntimeEnvironment).
        await as('repo_admin').patch('/runtime/environments/env-x/settings').send({ diagnosticHold: true }).expect(403);
        await as('owner').patch('/runtime/environments/env-x/settings').send({ diagnosticHold: true }).expect(404);
        // The machine size is a preset or null; anything else stops at the DTO.
        await as('repo_admin').patch('/runtime/environments/env-x/settings').send({ machineSize: 'large' }).expect(403);
        await as('owner').patch('/runtime/environments/env-x/settings').send({ machineSize: 'large' }).expect(404);
        await as('owner').patch('/runtime/environments/env-x/settings').send({ machineSize: null }).expect(404);
        await as('owner').patch('/runtime/environments/env-x/settings').send({ machineSize: 'huge' }).expect(400);
        await as('owner').patch('/runtime/environments/env-x/settings').send({ machineSize: { memoryMb: 65_536, cpus: 32 } }).expect(400);
    });

    it('ops routes: the global stop and the managed fleet answer only the Kodus on-call', async () => {
        await as('owner').post('/internal/runtime/ops/stop').expect(404);
        await as('outsider').post('/internal/runtime/ops/stop/clear').expect(404);
        await as('oncall').post('/internal/runtime/ops/stop').expect(202);
        await as('oncall').post('/internal/runtime/ops/stop/clear').expect(202);
        expect(outbox.events).toEqual(expect.arrayContaining(['runtime.stop.requested', 'runtime.stop.cleared']));
        await as('oncall').post('/internal/runtime/ops/cells/nope/revoke').send({}).expect(404);
    });

    it('request bodies are validated before any use case: unknown fields and wrong types are 400', async () => {
        await as('owner').post('/runtime/stop').send({ scope: 'org', extra: 1 }).expect(400);
        await as('owner').post('/runtime/cells/registration-tokens').send({ topology: 'cloud' }).expect(400);
        await as('owner').post('/runtime/environments/env-x/egress-approvals').send({}).expect(400);
        await as('owner').patch('/runtime/settings').send({}).expect(400);
        await as('owner').patch('/runtime/settings').send({ tokenBudgetPerDay: null }).expect(200);
        await as('owner').put(`/runtime/settings/repositories/${REPO}`).send({ whoCanAsk: 'everyone' }).expect(400);
        await as('owner').post('/runtime/runs').send({}).expect(400);
        await as('contributor').get('/runtime/runs?limit=abc').expect(400);
        await as('contributor').get(`/runtime/runs/${done.runId}/evidence/s1?side=${'x'.repeat(40)}`).expect(400);
    });

    it('PUT /teams/:teamId/cli-keys/:keyId/repositories: owner only, key of that team, configured repos, audited', async () => {
        const path = (team: string, key = 'k1') => `/teams/${team}/cli-keys/${key}/repositories`;
        await as('contributor').put(path(TEAM)).send({ repositoryIds: [REPO] }).expect(403);
        await as('owner').put(path('other-team')).send({ repositoryIds: [REPO] }).expect(404);
        await as('owner').put(path(TEAM, 'nope')).send({ repositoryIds: [REPO] }).expect(404);
        await as('owner').put(path(TEAM)).send({ repositoryIds: 'all' }).expect(400);
        await as('owner').put(path(TEAM)).send({ repositoryIds: ['repo-unknown'] }).expect(400);
        expect(keyUpdates).toHaveLength(0);
        expect(audit.emit).not.toHaveBeenCalled();

        const res = await as('owner').put(path(TEAM)).send({ repositoryIds: [REPO] }).expect(200);
        expect(res.body).toEqual({ uuid: 'k1', repositoryIds: [REPO] });
        expect(keyUpdates[0].config).toEqual({ capabilities: ['runs:read'], repositoryIds: [REPO] });
        expect(audit.emit).toHaveBeenCalledWith('audit.cliKey', expect.objectContaining({ keyName: 'ci', actionType: 'edit', organizationAndTeamData: { organizationId: ORG, teamId: TEAM } }));
        // The old path is gone.
        await as('owner').put('/team-keys/k1/repositories').send({ repositoryIds: [REPO] }).expect(404);
    });

    it("an environment's repositories: readers list them, only the org admin adds, changes or removes one, another org is 404", async () => {
        const path = '/runtime/environments/env-x/repositories';
        await as('billing_manager').get(path).expect(403);
        await as('outsider').get(path).expect(404);
        for (const who of ['repo_admin', 'contributor']) {
            await as(who).post(path).send({ repositoryId: REPO }).expect(403);
            await as(who).patch(`${path}/${REPO}`).send({ triggers: false }).expect(403);
            await as(who).delete(`${path}/${REPO}`).expect(403);
        }
        await as('owner').post(path).send({ repositoryId: REPO }).expect(404);
        await as('outsider').post(path).send({ repositoryId: REPO }).expect(404);
        await as('owner').delete(`${path}/${REPO}`).expect(404);
    });

    it("a repository's place in an environment is not writable through the body: role, primary and environment are refused, the alias is a directory name", async () => {
        const path = '/runtime/environments/env-x/repositories';
        await as('owner').patch(`${path}/${REPO}`).send({ role: 'primary' }).expect(400);
        await as('owner').patch(`${path}/${REPO}`).send({ triggers: true, role: 'primary' }).expect(400);
        await as('owner').patch(`${path}/${REPO}`).send({ environmentId: 'env-other' }).expect(400);
        await as('owner').post(path).send({ repositoryId: REPO, role: 'primary' }).expect(400);
        for (const alias of ['../billing', 'Billing', '', '.hidden', 'a/b']) {
            await as('owner').post(path).send({ repositoryId: REPO, alias }).expect(400);
            await as('owner').patch(`${path}/${REPO}`).send({ alias }).expect(400);
        }
    });

    it('pull request screens: Runtime state needs Read on Runs (billing is 403); Run on this PR needs Create (a contributor is 403)', async () => {
        const one = { pullRequests: [{ repositoryId: REPO, prNumber: 7 }] };
        await as('contributor').post('/runtime/pull-request-runs').send(one).expect(200);
        await as('billing_manager').post('/runtime/pull-request-runs').send(one).expect(403);
        await as('contributor').post('/runtime/pull-request-runs/request').send({ repositoryId: REPO, prNumber: 7 }).expect(403);
        await as('billing_manager').post('/runtime/pull-request-runs/request').send({ repositoryId: REPO, prNumber: 7 }).expect(403);
        // Past the guard: no environment of the repository in this org.
        await as('owner').post('/runtime/pull-request-runs/request').send({ repositoryId: REPO, prNumber: 7 }).expect(404);
    });

    it('POST /runtime/runs/:id/approvals is a write: Create on RuntimeRun, not Read', async () => {
        await as('contributor').post(`/runtime/runs/${done.runId}/approvals`).expect(403);
        await as('owner').post(`/runtime/runs/${done.runId}/approvals`).expect(409);
    });

    it('POST /runtime/runs (Run again) needs Create on RuntimeRun', async () => {
        await as('contributor').post('/runtime/runs').send({ runId: done.runId }).expect(403);
        await as('billing_manager').post('/runtime/runs').send({ runId: done.runId }).expect(403);
        await as('owner').post('/runtime/runs').send({ runId: live.runId }).expect(409);
    });

    it('POST /internal/runtime/llm takes the Run token, not a session', async () => {
        await request(app.getHttpServer()).post('/internal/runtime/llm').send({}).expect(401);
        const token = signRunToken(
            { runId: live.runId, attempt: 1, organizationId: ORG, teamId: TEAM, repositoryId: REPO, prNumber: 7, exp: Math.floor(Date.now() / 1000) + 600 },
            SECRET,
        );
        const res = await request(app.getHttpServer())
            .post('/internal/runtime/llm')
            .set('authorization', `Bearer ${token}`)
            .send({ runId: live.runId, task: 'runtime.plan', messages: [{ role: 'user', content: 'hi' }] })
            .expect(200);
        expect(res.body).toMatchObject({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
    });

    it('POST /internal/runtime/recipe-author hands the setup token to the use case; a request that closes stops the run', async () => {
        recipeAuthorCalls.length = 0;
        const res = await request(app.getHttpServer()).post('/internal/runtime/recipe-author').set('authorization', 'Bearer kst1.x.y').send({ sha: 'a'.repeat(40) }).expect(200);
        expect(res.body).toMatchObject({ status: 'no_recipe' });
        expect(recipeAuthorCalls[0]).toMatchObject({ authorization: 'Bearer kst1.x.y', body: { sha: 'a'.repeat(40) } });
        // Answered: the run's signal never fired.
        expect(recipeAuthorCalls[0].signal?.aborted).toBe(false);

        // The worker gives up on the request (its timeout, a restart): the agent run is aborted with it.
        // Abort only once the handler holds the request, so a slow machine never aborts before it arrives.
        const hanging = request(app.getHttpServer()).post('/internal/runtime/recipe-author').send({ hang: true });
        hanging.then(
            () => undefined,
            () => undefined,
        );
        for (let i = 0; i < 500 && !recipeAuthorCalls[1]; i++) await new Promise((r) => setTimeout(r, 10));
        expect(recipeAuthorCalls[1]).toBeDefined();
        hanging.abort();
        for (let i = 0; i < 500 && !recipeAuthorCalls[1]?.signal?.aborted; i++) await new Promise((r) => setTimeout(r, 10));
        expect(recipeAuthorCalls[1].signal?.aborted).toBe(true);
    });

    it('POST /internal/runtime/setup-repo-tokens takes the setup token, not a session: 401 without it, 404 for a setup that is not running', async () => {
        await as('owner').post('/internal/runtime/setup-repo-tokens').send({ attempt: 'repair-1' }).expect(401);
        const token = signSetupToken(
            { setupKey: 'env-1:2026-10-29T12:00:00.000Z', environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, exp: Math.floor(Date.now() / 1000) + 600 },
            SECRET,
        );
        await request(app.getHttpServer()).post('/internal/runtime/setup-repo-tokens').set('authorization', `Bearer ${token}`).send({ attempt: 'repair-1' }).expect(404);
    });
});
