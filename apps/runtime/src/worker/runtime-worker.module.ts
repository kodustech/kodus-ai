import type { EvidenceUploads } from './run/run-evidence';
import { LOCK_SCOPED_PG, LockScopedPg } from '../shared/persistence/lock-scoped-pg';
import { PR_ADMISSION_STORE, PgPrAdmissionStore } from '../shared/admission/pr-admission-store';
import { AmqpConnection, RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { DynamicModule, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool, type PoolConfig } from 'pg';

import { PgLessonStore } from '@libs/runtime/blockers/pg-lesson.store';
import type { RunProjectionStore } from '@libs/runtime/run';
import { PgEnvironmentSetupStore } from '@libs/runtime/run/adapters/pg-environment-setup.store';
import { PgRunProjectionStore } from '@libs/runtime/run/adapters/pg-run-projection.store';
import { PgSql } from '@libs/runtime/run/adapters/pg-sql';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { PgCellDirectory, pgTransaction } from '../shared/persistence/cell-directory';
import { PgAdmissionStore } from '../shared/admission/pg-admission-store';
import { PgPhysicalAdmissionDirectory } from '../shared/admission/physical-admission-directory';
import { COMMAND_STORE, RUNTIME_CONFIG, RUNTIME_PG_POOL, RUNTIME_RUN_PROJECTION_STORE, WorkerConfig } from '../shared/config';
import { PgSnapshotPlacements } from '../shared/persistence/snapshot-placements';
import { PullRequestSessions } from './sandbox/pr-sessions';
import { type EvidenceStore, FileEvidenceStore } from '../shared/evidence/file-evidence-store';
import { S3EvidenceStore } from '../shared/evidence/s3-evidence-store';
import { PgDistributedLocks } from '../shared/persistence/locks';
import { PgCommandStore } from '../shared/persistence/pg-command-store';
import { applyRetention, ensureDatabase, ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { HttpLlmGateway } from './agent/http-llm-gateway';
import { HttpRecipeAuthorClient } from './agent/http-recipe-author';
import { HttpSetupRepoTokensClient } from './agent/http-setup-repo-tokens';
import { HttpRunPlanClient } from './agent/http-run-plan';
import { WorkerRunPlanClient } from './agent/worker-plan-client';
import { StepPastPlans } from './run/plan-reuse';
import { HmacCanaryVault } from './canary/canary';
import { RecordedLlmGateway } from './agent/llm-gateway';
import { RuntimeCommandConsumer } from './consumer/run-request.consumer';
import { CONSUMER_LOCKS, EGRESS_POLICY_PUSHER, POOL_TARGET_SENDER, PR_SESSIONS, runtimeCommandHandlersProvider } from './commands/runtime-command-handlers';
import { RUNTIME_RUN_RETRY_EXCHANGE } from '@libs/runtime/run/run-messages';
import { RuntimeRunRetry } from './consumer/runtime-run-retry';
import { canaryKeyFrom, hubEnvironments, loadRecordedTurns, poolCellOf, RUN_DEPS_FACTORY, RunDependenciesFactory } from './dbos/run-deps.factory';
import { RUN_ENGINE_LOCKS, RUN_ENGINE_RETENTION, RUN_ENGINE_STUCK, RunEngineService } from './dbos/run-engine.service';
import { PgStuckSource, StuckDetector } from './maintenance/stuck-detector';
import { ADMISSION_COORDINATOR, AdmissionCoordinator } from './dbos/admission-coordinator';
import { HubPhysicalAdmissionClient } from './env/physical-admission-client';
import { HubClaimReleaser, HubClient, HubEgressPolicyPusher, HubPoolTargetSender, HubRunEventSink } from './env/hub-environment-runtime';
import { EVIDENCE_CONFIG, EVIDENCE_STORE, RuntimeEvidenceService } from './evidence/evidence.service';
import { PgRunClaims } from './persistence/pg-run-claims';
import { PgStabilityHistory } from './run/pg-stability-history';
import { AmqpPublishRequester } from './publish/amqp-publish-requester';
import { SealedSecretOpener, SECRET_OPENER } from './secrets/sealed-tokens';
import { ENVIRONMENT_SETUP_SERVICE, EnvironmentSetupService, type SetupOptions, setupOptionsFrom } from './setup/environment-setup.service';
import { ENVIRONMENT_SETUP_STORE, type EnvironmentSetupStore } from './setup/environment-setup.store';
import { LESSON_STORE, type LessonStore } from './setup/lesson.store';
import { EnvSessionListener } from './env-session/env-session.listener';
import { HubPreviewRoutes } from './preview/hub-preview-routes';
import { PREVIEW_SERVICE, PreviewService } from './preview/preview.service';
import { PgPreviewStore } from '../shared/persistence/preview-store';
import { ENV_SESSION_SERVICE, EnvSessionService } from './env-session/env-session.service';
import { SANDBOX_SERVICE, SandboxService } from './sandbox/sandbox.service';
import { PgEnvSessionStore } from './env-session/env-session.store';

const HUB_CLIENT = Symbol('HUB_CLIENT');
/** The PR and maintenance locks' own connections (runtimePgPoolOptions). */
export const RUNTIME_LOCK_PG_POOL = Symbol('RUNTIME_LOCK_PG_POOL');

/**
 * A lock holder keeps its lock connection and asks the store pool for another one, so the locks get
 * their own pool sized to every delivery the two lanes can hold at once: a full store pool then only
 * slows a holder, never deadlocks it. Both wait at most connectionTimeoutMs for a connection.
 */
export function runtimePgPoolOptions(config: Pick<WorkerConfig, 'databaseUrl' | 'pg'>): { store: PoolConfig; locks: PoolConfig } {
    const common = { connectionString: config.databaseUrl, connectionTimeoutMillis: config.pg.connectionTimeoutMs };
    return { store: { ...common, max: config.pg.poolMax }, locks: { ...common, max: config.pg.lockPoolMax } };
}
const logger = new Logger('RuntimeWorker');

/**
 * The runtime-worker: the broker consumer, the DBOS engine and the evidence
 * server, wired from one validated WorkerConfig (no import-time side effects).
 */
@Module({})
export class RuntimeWorkerModule implements OnApplicationShutdown {
    constructor(
        @Inject(RUNTIME_PG_POOL) private readonly pool: Pool,
        @Inject(RUNTIME_LOCK_PG_POOL) private readonly lockPool: Pool,
    ) {}

    static forConfig(config: WorkerConfig): DynamicModule {
        return {
            module: RuntimeWorkerModule,
            imports: [
                RabbitMQModule.forRoot({
                    uri: config.rabbitUrl,
                    // The Runtime's broker user may not configure workflow.exchange: it is
                    // checked (passive), never declared (scripts/runtime/dev-runtime-users.sh).
                    exchanges: [{ name: 'workflow.exchange', type: 'topic', createExchangeIfNotExists: false }, { name: RUNTIME_RUN_RETRY_EXCHANGE, type: 'headers', createExchangeIfNotExists: false }],
                    channels: { 'channel-runtime-run': { prefetchCount: config.brokerPrefetch }, 'channel-runtime-control': { prefetchCount: config.brokerPrefetch } },
                    connectionInitOptions: { wait: true, timeout: 30_000 },
                    enableControllerDiscovery: false,
                }),
            ],
            providers: [
                { provide: RuntimeRunRetry, inject: [AmqpConnection], useFactory: (amqp: AmqpConnection) => new RuntimeRunRetry(amqp, config.brokerRetry) },
                { provide: RUNTIME_CONFIG, useValue: config },
                { provide: EVIDENCE_CONFIG, useValue: config.evidence },
                {
                    provide: EVIDENCE_STORE,
                    useFactory: (): EvidenceStore | null =>
                        config.evidence.store === 's3' && config.evidence.s3
                            ? new S3EvidenceStore(config.evidence.s3)
                            : config.evidence.dir
                              ? new FileEvidenceStore(config.evidence.dir)
                              : null,
                },
                RuntimeEvidenceService,
                { provide: RuntimeMetrics, useFactory: () => new RuntimeMetrics() },
                { provide: SECRET_OPENER, useFactory: () => new SealedSecretOpener(config.secretSealKey) },
                {
                    provide: RUNTIME_PG_POOL,
                    useFactory: async () => {
                        await ensureDatabase(config.databaseUrl);
                        const pool = new Pool(runtimePgPoolOptions(config).store);
                        await ensureRuntimeSchema(pool);
                        return pool;
                    },
                },
                // After RUNTIME_PG_POOL: the database and schema exist by then.
                { provide: RUNTIME_LOCK_PG_POOL, inject: [RUNTIME_PG_POOL], useFactory: () => new Pool(runtimePgPoolOptions(config).locks) },
                { provide: RUN_ENGINE_LOCKS, inject: [RUNTIME_LOCK_PG_POOL], useFactory: (pool: Pool) => new PgDistributedLocks(pool) },
                {
                    // The hang detector: one pass at the end of each maintenance tick (docs/runtime/observability.md part 4).
                    provide: RUN_ENGINE_STUCK,
                    inject: [RUNTIME_PG_POOL, RUNTIME_RUN_PROJECTION_STORE, RuntimeMetrics],
                    useFactory: (pool: Pool, projection: RunProjectionStore, metrics: RuntimeMetrics) =>
                        new StuckDetector(
                            new PgStuckSource(
                                pool,
                                () => projection.listLive(),
                                async () =>
                                    (await DBOS.listWorkflows({ status: ['PENDING', 'ENQUEUED'], limit: 500, sortDesc: false })).map((w) => ({
                                        workflowId: w.workflowID,
                                        name: w.workflowName,
                                        status: w.status,
                                        createdAt: w.createdAt,
                                    })),
                            ),
                            metrics,
                            { warn: (fields) => logger.warn(fields) },
                        ),
                },
                { provide: CONSUMER_LOCKS, useExisting: RUN_ENGINE_LOCKS },
                { provide: LOCK_SCOPED_PG, inject: [RUNTIME_PG_POOL, RUN_ENGINE_LOCKS], useFactory: (pool: Pool, locks: PgDistributedLocks) => new LockScopedPg(pool, locks) },
                { provide: PR_ADMISSION_STORE, inject: [RUNTIME_PG_POOL, LOCK_SCOPED_PG], useFactory: (pool: Pool, sql: LockScopedPg) => new PgPrAdmissionStore(pool, sql) },
                { provide: RUN_ENGINE_RETENTION, inject: [RUNTIME_PG_POOL], useFactory: (pool: Pool) => () => applyRetention(pool) },
                {
                    // runtime.runtime_runs in the Runtime Postgres (v21 of runtime-schema.ts), written from the DBOS steps.
                    provide: RUNTIME_RUN_PROJECTION_STORE,
                    inject: [RUNTIME_PG_POOL],
                    useFactory: (pool: Pool): RunProjectionStore => new PgRunProjectionStore(new PgSql(() => pool)),
                },
                {
                    provide: HUB_CLIENT,
                    inject: [RUNTIME_PG_POOL],
                    useFactory: (pool: Pool) =>
                        new HubClient({
                            tls: config.tls?.workerCert && config.tls.workerKey ? { cert: config.tls.workerCert, key: config.tls.workerKey, ca: config.tls.ca } : undefined,
                            testOnlyToken: config.testOnlyPlaintext?.internalToken,
                            cellDirectory: new PgCellDirectory(pool, { sharedClaimCap: config.orgSharedClaimCap, inTransaction: pgTransaction(pool) }),
                            hubBaseUrl: config.hubUrl,
                        }),
                },
                {
                    provide: ADMISSION_COORDINATOR,
                    inject: [RUNTIME_PG_POOL, HUB_CLIENT, LOCK_SCOPED_PG],
                    useFactory: (pool: Pool, hub: HubClient, sql: LockScopedPg) => config.durableAdmission
                        ? new AdmissionCoordinator(new PgAdmissionStore(pool, sql), new HubPhysicalAdmissionClient(hub, new PgPhysicalAdmissionDirectory(sql, { sharedClaimCap: config.orgSharedClaimCap, inTransaction: fn => sql.transaction(fn) })), config.admission)
                        : undefined,
                },
                {
                    provide: RUN_DEPS_FACTORY,
                    inject: [RUNTIME_PG_POOL, RUNTIME_RUN_PROJECTION_STORE, AmqpConnection, RuntimeMetrics, EVIDENCE_STORE, HUB_CLIENT, SECRET_OPENER, ENVIRONMENT_SETUP_STORE],
                    useFactory: async (
                        pool: Pool,
                        projection: RunProjectionStore,
                        amqp: AmqpConnection,
                        metrics: RuntimeMetrics,
                        store: EvidenceStore | null,
                        hub: HubClient,
                        secrets: SealedSecretOpener,
                        setups: EnvironmentSetupStore,
                    ) => {
                        // S3: presigned PUTs to the bucket. File: grants only where a cell can reach this
                        // evidence server and it is up to take them. The same store gives an upload its reads.
                        const evidenceUploads: EvidenceUploads | undefined =
                            store instanceof S3EvidenceStore
                                ? { presigner: store }
                                : store && config.evidence.uploadUrl && config.evidence.secret && config.evidence.port
                                  ? { baseUrl: config.evidence.uploadUrl, secret: config.evidence.secret }
                                  : undefined;
                        const environment =
                            config.envDriver === 'fake'
                                ? await fakeEnvironments() // dev only: the production image refuses RUNTIME_ENV_DRIVER=fake
                                : hubEnvironments(hub, secrets, config.git, poolCellOf(setups), setups, evidenceUploads);
                        return new RunDependenciesFactory({
                            environment,
                            allowUnrenewedClaims: config.envDriver === 'fake',
                            projection,
                            // A Run of a head already planned takes that Run's accepted plan from its workflow's steps.
                            pastPlans: new StepPastPlans(projection, async (id) => (await DBOS.listWorkflowSteps(id))?.map((s) => ({ name: s.name, output: s.output }))),
                            stability: new PgStabilityHistory(pool),
                            claims: new PgRunClaims(pool),
                            releaser: new HubClaimReleaser(hub),
                            publisher: new AmqpPublishRequester(amqp),
                            llm: config.llmGatewayUrl
                                ? new HttpLlmGateway(config.llmGatewayUrl, { secrets, metrics })
                                : new RecordedLlmGateway(loadRecordedTurns(config.llmFixturePath), { maxTokensPerRun: config.maxTokensPerRun, metrics }),
                            // The test planner runs in the product on the agent harness (ADR-069), with the org's key.
                            ...(config.llmGatewayUrl ? { planner: config.plannerHost === 'worker' ? new WorkerRunPlanClient(config.llmGatewayUrl, { secrets, canaries: new HmacCanaryVault(canaryKeyFrom(config.secretSealKey)) }) : new HttpRunPlanClient(config.llmGatewayUrl, { secrets }) } : {}),
                            metrics,
                            events: new HubRunEventSink(hub, (e, event) => logger.warn({ msg: 'stream.event_dropped', type: event.type, error: e.message })),
                            canaryKey: canaryKeyFrom(config.secretSealKey),
                            onReleaseFailed: (claimId, e) => logger.warn({ msg: 'claim.release_failed', claimId, error: e.message }),
                            // A miss is retried in a minute; only those reach the log, and the renewals themselves.
                            onLeaseEvent: (runId, e) =>
                                e.type === 'retry'
                                    ? logger.warn({ msg: 'claim.renew_missed', runId, claimId: e.claimId, error: e.error })
                                    : logger.log({ msg: `claim.renew.${e.type}`, runId, claimId: e.claimId, ...(e.type === 'renewed' ? { leaseExpiresAt: e.leaseExpiresAt, atCeiling: e.atCeiling } : {}) }),
                            ...(store ? { evidence: store } : {}),
                            ...(evidenceUploads ? { evidenceUploads } : {}),
                            log: { info: (e) => logger.log(e), warn: (e) => logger.warn(e) },
                            ...(config.roundSnapshots ? { roundSnapshots: true } : {}),
                        });
                    },
                },
                {
                    provide: ENVIRONMENT_SETUP_STORE,
                    inject: [RUNTIME_PG_POOL],
                    useFactory: (pool: Pool): EnvironmentSetupStore => new PgEnvironmentSetupStore(new PgSql(() => pool)),
                },
                {
                    provide: LESSON_STORE,
                    inject: [RUNTIME_PG_POOL],
                    useFactory: (pool: Pool): LessonStore => new PgLessonStore(new PgSql(() => pool)),
                },
                {
                    provide: ENVIRONMENT_SETUP_SERVICE,
                    inject: [RUN_DEPS_FACTORY, ENVIRONMENT_SETUP_STORE, LESSON_STORE, COMMAND_STORE, SECRET_OPENER, RuntimeMetrics],
                    useFactory: (
                        deps: RunDependenciesFactory,
                        store: EnvironmentSetupStore,
                        lessons: LessonStore,
                        commands: PgCommandStore,
                        secrets: SealedSecretOpener,
                        metrics: RuntimeMetrics,
                    ) => {
                        const opts: SetupOptions = {
                            ...setupOptionsFrom(config.setup),
                            metrics,
                            lessons: { store: lessons, approvedHosts: (org, env) => commands.approvedHosts(org, env) },
                            // Kody's learn loop needs the product's gateway; recorded fixtures never answer a setup, so without it the loop is off.
                            ...(config.llmGatewayUrl
                                ? {
                                      learn: {
                                          llm: new HttpLlmGateway(config.llmGatewayUrl, { secrets, metrics, maxOutputTokens: 1_024, timeoutMs: 120_000 }),
                                          lessons,
                                      },
                                      // Kody writes a missing recipe in the product, with the setup token (the agent and the key stay there).
                                      author: new HttpRecipeAuthorClient(config.llmGatewayUrl, { secrets }),
                                      // Each repair's boot downloads with fresh tokens the product mints for the setup.
                                      repoTokens: new HttpSetupRepoTokensClient(config.llmGatewayUrl, { secrets }),
                                  }
                                : {}),
                        };
                        if (opts.devSha || opts.devExpose) {
                            logger.warn({ msg: 'setup.dev_override', devSha: opts.devSha?.slice(0, 12) ?? null, devExpose: !!opts.devExpose });
                        }
                        return new EnvironmentSetupService(deps, store, opts);
                    },
                },
                { provide: COMMAND_STORE, inject: [RUNTIME_PG_POOL, LOCK_SCOPED_PG], useFactory: (pool: Pool, sql: LockScopedPg) => new PgCommandStore(pool, sql) },
                {
                    provide: EGRESS_POLICY_PUSHER,
                    inject: [HUB_CLIENT, RUNTIME_PG_POOL],
                    useFactory: (hub: HubClient, pool: Pool) => {
                        const claims = new PgRunClaims(pool);
                        return new HubEgressPolicyPusher(hub, (org, env) => claims.replicasOfEnvironment(org, env));
                    },
                },
                {
                    provide: POOL_TARGET_SENDER,
                    inject: [HUB_CLIENT, RUNTIME_PG_POOL],
                    useFactory: (hub: HubClient, pool: Pool) => {
                        const cells = new PgCellDirectory(pool, { inTransaction: pgTransaction(pool) });
                        return new HubPoolTargetSender(hub, (cellId) => cells.replicaForCell(cellId));
                    },
                },
                {
                    // The dev's interactive sessions over /mcp/env (Inc. 1): claims with consumer mcp, through the same hub client.
                    provide: ENV_SESSION_SERVICE,
                    inject: [RUNTIME_PG_POOL, RUN_DEPS_FACTORY, ENVIRONMENT_SETUP_STORE, COMMAND_STORE, EVIDENCE_STORE],
                    useFactory: async (pool: Pool, deps: RunDependenciesFactory, setups: EnvironmentSetupStore, commands: PgCommandStore, evidence: EvidenceStore | null) => {
                        await PgEnvSessionStore.ensureSchema(pool);
                        return new EnvSessionService({
                            store: new PgEnvSessionStore(pool),
                            setups,
                            environment: (input) => deps.envForSession(input),
                            isStopped: (org) => commands.isStopped(org),
                            // env_upload keeps a call's files where the cells read the Runs' evidence.
                            ...(evidence ? { evidence } : {}),
                            onWarn: (msg, meta) => logger.warn({ msg, ...meta }),
                        });
                    },
                },
                {
                    // Code sandboxes for the review and custom agents (docs/runtime/sandbox.md), on the env-session listener.
                    provide: SANDBOX_SERVICE,
                    inject: [HUB_CLIENT, COMMAND_STORE, RUNTIME_PG_POOL],
                    useFactory: (hub: HubClient, commands: PgCommandStore, pool: Pool) =>
                        new SandboxService({ hub, isStopped: (org) => commands.isStopped(org), placements: new PgSnapshotPlacements(pool) }),
                },
                {
                    // Preview URLs (docs/runtime/preview-urls.md): claims with consumer preview, on the env-session listener.
                    provide: PREVIEW_SERVICE,
                    inject: [RUNTIME_PG_POOL, RUN_DEPS_FACTORY, ENVIRONMENT_SETUP_STORE, COMMAND_STORE, HUB_CLIENT],
                    useFactory: (pool: Pool, deps: RunDependenciesFactory, setups: EnvironmentSetupStore, commands: PgCommandStore, hub: HubClient) => {
                        const previewCanaries = new HmacCanaryVault(canaryKeyFrom(config.secretSealKey));
                        return new PreviewService({
                            store: new PgPreviewStore(pool),
                            setups,
                            environment: (input) => deps.envForSession(input),
                            hub: new HubPreviewRoutes(hub),
                            isStopped: (org) => commands.isStopped(org),
                            ...(config.previewDomain ? { domain: config.previewDomain } : {}),
                            // Each start's decoys (ADR-043), from the same key as a Run's: its own per preview and start.
                            canaries: (previewId, start) => previewCanaries.forRun({ runId: previewId, runToken: `preview-start-${start}` }).map((c) => ({ slot: c.slot, value: c.value })),
                            log: (level, msg, fields) => logger[level === 'info' ? 'log' : level]({ msg, ...fields }),
                        });
                    },
                },
                {
                    // A closed or merged PR's sessions, removed from their cells (pr-sessions.ts).
                    provide: PR_SESSIONS,
                    inject: [HUB_CLIENT, RUNTIME_PG_POOL],
                    useFactory: (hub: HubClient, pool: Pool) => new PullRequestSessions(hub, new PgSnapshotPlacements(pool), (msg, meta) => new Logger('PullRequestSessions').log({ msg, ...meta })),
                },
                EnvSessionListener,
                RunEngineService,
                runtimeCommandHandlersProvider,
                RuntimeCommandConsumer,
            ],
        };
    }

    async onApplicationShutdown() {
        // Shutting down: a pool that fails to end has nothing left to serve, and the process exits next.
        await Promise.all([this.pool.end().catch(() => undefined), this.lockPool.end().catch(() => undefined)]);
    }
}

/** The in-memory environment of the dev fake driver (never in the production image). */
async function fakeEnvironments() {
    const [{ FakeEnvironmentRuntime }, { SCENARIOS }] = await Promise.all([import('@libs/runtime/environment'), import('../fake-cell/scenarios')]);
    const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
    return () => env;
}
