import { LOCK_SCOPED_PG, LockScopedPg } from '../shared/persistence/lock-scoped-pg';
import { PR_ADMISSION_STORE, PgPrAdmissionStore } from '../shared/admission/pr-admission-store';
import { AmqpConnection, RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { DynamicModule, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';

import { RUNTIME_LESSONS_COLLECTION } from '@libs/runtime/blockers/lessons';
import { RUNTIME_ENVIRONMENT_SETUPS_COLLECTION, RUNTIME_RUNS_COLLECTION, RunProjectionStore } from '@libs/runtime/run';
import { MongoRunProjectionStore } from '@libs/runtime/run/adapters/mongo-run-projection.store';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { PgCellDirectory, pgTransaction } from '../shared/persistence/cell-directory';
import { PgAdmissionStore } from '../shared/admission/pg-admission-store';
import { PgPhysicalAdmissionDirectory } from '../shared/admission/physical-admission-directory';
import { COMMAND_STORE, RUNTIME_CONFIG, RUNTIME_PG_POOL, WorkerConfig } from '../shared/config';
import { type EvidenceStore, FileEvidenceStore } from '../shared/evidence/file-evidence-store';
import { S3EvidenceStore } from '../shared/evidence/s3-evidence-store';
import { PgDistributedLocks } from '../shared/persistence/locks';
import { PgCommandStore } from '../shared/persistence/pg-command-store';
import { applyRetention, ensureDatabase, ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { HttpLlmGateway } from './agent/http-llm-gateway';
import { HttpRecipeAuthorClient } from './agent/http-recipe-author';
import { HttpRunPlanClient } from './agent/http-run-plan';
import { WorkerRunPlanClient } from './agent/worker-plan-client';
import { HmacCanaryVault } from './canary/canary';
import { RecordedLlmGateway } from './agent/llm-gateway';
import { CONSUMER_LOCKS, EGRESS_POLICY_PUSHER, POOL_TARGET_SENDER, RuntimeCommandConsumer } from './consumer/run-request.consumer';
import { RUNTIME_RUN_RETRY_EXCHANGE } from '@libs/runtime/run/run-messages';
import { RuntimeRunRetry } from './consumer/runtime-run-retry';
import { canaryKeyFrom, hubEnvironments, loadRecordedTurns, poolCellOf, RUN_DEPS_FACTORY, RunDependenciesFactory } from './dbos/run-deps.factory';
import { RUN_ENGINE_LOCKS, RUN_ENGINE_RETENTION, RunEngineService } from './dbos/run-engine.service';
import { ADMISSION_COORDINATOR, AdmissionCoordinator } from './dbos/admission-coordinator';
import { HubPhysicalAdmissionClient } from './env/physical-admission-client';
import { HubClaimReleaser, HubClient, HubEgressPolicyPusher, HubPoolTargetSender, HubRunEventSink } from './env/hub-environment-runtime';
import { EVIDENCE_CONFIG, EVIDENCE_STORE, RuntimeEvidenceService } from './evidence/evidence.service';
import { PgRunClaims } from './persistence/pg-run-claims';
import { AmqpPublishRequester } from './publish/amqp-publish-requester';
import { SealedSecretOpener, SECRET_OPENER } from './secrets/sealed-tokens';
import { ENVIRONMENT_SETUP_SERVICE, EnvironmentSetupService, type SetupOptions, setupOptionsFrom } from './setup/environment-setup.service';
import { ENVIRONMENT_SETUP_STORE, EnvironmentSetupStore, InMemoryEnvironmentSetupStore, MongoEnvironmentSetupStore } from './setup/environment-setup.store';
import { InMemoryLessonStore, LESSON_STORE, type LessonStore, MongoLessonStore } from './setup/lesson.store';
import { EnvSessionListener } from './env-session/env-session.listener';
import { ENV_SESSION_SERVICE, EnvSessionService } from './env-session/env-session.service';
import { PgEnvSessionStore } from './env-session/env-session.store';

const MONGO_CLIENT = Symbol('MONGO_CLIENT');
const RUN_PROJECTION = 'RUN_PROJECTION';
const HUB_CLIENT = Symbol('HUB_CLIENT');
const logger = new Logger('RuntimeWorker');

/**
 * The runtime-worker: the broker consumer, the DBOS engine and the evidence
 * server, wired from one validated WorkerConfig (no import-time side effects).
 */
@Module({})
export class RuntimeWorkerModule implements OnApplicationShutdown {
    constructor(
        @Inject(RUNTIME_PG_POOL) private readonly pool: Pool,
        @Inject(MONGO_CLIENT) private readonly mongo: MongoClient | null,
    ) {}

    static forConfig(config: WorkerConfig): DynamicModule {
        return {
            module: RuntimeWorkerModule,
            imports: [
                RabbitMQModule.forRoot({
                    uri: config.rabbitUrl,
                    // The Runtime's broker user may not configure workflow.exchange: it is
                    // checked (passive), never declared (scripts/runtime/dev-runtime-users.sh).
                    exchanges: [{ name: 'workflow.exchange', type: 'topic', createExchangeIfNotExists: false }, { name: RUNTIME_RUN_RETRY_EXCHANGE, type: 'x-delayed-message', createExchangeIfNotExists: false }],
                    channels: { 'channel-runtime-run': { prefetchCount: 10 }, 'channel-runtime-control': { prefetchCount: 10 } },
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
                        const pool = new Pool({ connectionString: config.databaseUrl, max: 10, ...(config.durableAdmission ? { connectionTimeoutMillis: 5000 } : {}) });
                        await ensureRuntimeSchema(pool);
                        return pool;
                    },
                },
                { provide: RUN_ENGINE_LOCKS, inject: [RUNTIME_PG_POOL], useFactory: (pool: Pool) => new PgDistributedLocks(pool) },
                { provide: CONSUMER_LOCKS, useExisting: RUN_ENGINE_LOCKS },
                { provide: LOCK_SCOPED_PG, inject: [RUNTIME_PG_POOL, RUN_ENGINE_LOCKS], useFactory: (pool: Pool, locks: PgDistributedLocks) => new LockScopedPg(pool, locks) },
                { provide: PR_ADMISSION_STORE, inject: [RUNTIME_PG_POOL, LOCK_SCOPED_PG], useFactory: (pool: Pool, sql: LockScopedPg) => new PgPrAdmissionStore(pool, sql) },
                { provide: RUN_ENGINE_RETENTION, inject: [RUNTIME_PG_POOL], useFactory: (pool: Pool) => () => applyRetention(pool) },
                {
                    provide: MONGO_CLIENT,
                    useFactory: async () => {
                        if (!config.mongoUrl) return null;
                        const client = new MongoClient(config.mongoUrl);
                        await client.connect();
                        return client;
                    },
                },
                {
                    provide: RUN_PROJECTION,
                    inject: [MONGO_CLIENT],
                    useFactory: async (client: MongoClient | null): Promise<RunProjectionStore> => {
                        if (!client) {
                            logger.warn({ msg: 'RUNTIME_MONGO_URL not set: the Run projection is in memory' });
                            return new InMemoryRunProjectionStore();
                        }
                        const coll = client.db(config.mongoDb).collection<any>(RUNTIME_RUNS_COLLECTION);
                        await MongoRunProjectionStore.ensureIndexes(coll);
                        return new MongoRunProjectionStore(coll);
                    },
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
                    inject: [RUNTIME_PG_POOL, RUN_PROJECTION, AmqpConnection, RuntimeMetrics, EVIDENCE_STORE, HUB_CLIENT, SECRET_OPENER, ENVIRONMENT_SETUP_STORE],
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
                        const environment =
                            config.envDriver === 'fake'
                                ? await fakeEnvironments() // dev only: the production image refuses RUNTIME_ENV_DRIVER=fake
                                : hubEnvironments(hub, secrets, config.git, poolCellOf(setups));
                        return new RunDependenciesFactory({
                            environment,
                            allowUnrenewedClaims: config.envDriver === 'fake',
                            projection,
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
                            // S3: presigned PUTs to the bucket. File: grants only where a cell can reach this
                            // evidence server and it is up to take them.
                            ...(store instanceof S3EvidenceStore
                                ? { evidenceUploads: { presigner: store } }
                                : store && config.evidence.uploadUrl && config.evidence.secret && config.evidence.port
                                  ? { evidenceUploads: { baseUrl: config.evidence.uploadUrl, secret: config.evidence.secret } }
                                  : {}),
                            log: { info: (e) => logger.log(e), warn: (e) => logger.warn(e) },
                        });
                    },
                },
                {
                    provide: ENVIRONMENT_SETUP_STORE,
                    inject: [MONGO_CLIENT],
                    useFactory: async (client: MongoClient | null): Promise<EnvironmentSetupStore> => {
                        if (!client) return new InMemoryEnvironmentSetupStore();
                        const coll = client.db(config.mongoDb).collection<any>(RUNTIME_ENVIRONMENT_SETUPS_COLLECTION);
                        await MongoEnvironmentSetupStore.ensureIndexes(coll);
                        return new MongoEnvironmentSetupStore(coll);
                    },
                },
                {
                    provide: LESSON_STORE,
                    inject: [MONGO_CLIENT],
                    useFactory: async (client: MongoClient | null): Promise<LessonStore> => {
                        if (!client) return new InMemoryLessonStore();
                        const coll = client.db(config.mongoDb).collection<any>(RUNTIME_LESSONS_COLLECTION);
                        await MongoLessonStore.ensureIndexes(coll);
                        return new MongoLessonStore(coll);
                    },
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
                    inject: [RUNTIME_PG_POOL, RUN_DEPS_FACTORY, ENVIRONMENT_SETUP_STORE, COMMAND_STORE],
                    useFactory: async (pool: Pool, deps: RunDependenciesFactory, setups: EnvironmentSetupStore, commands: PgCommandStore) => {
                        await PgEnvSessionStore.ensureSchema(pool);
                        return new EnvSessionService({
                            store: new PgEnvSessionStore(pool),
                            setups,
                            environment: (input) => deps.envForSession(input),
                            isStopped: (org) => commands.isStopped(org),
                            onWarn: (msg, meta) => logger.warn({ msg, ...meta }),
                        });
                    },
                },
                EnvSessionListener,
                RunEngineService,
                RuntimeCommandConsumer,
            ],
        };
    }

    async onApplicationShutdown() {
        await this.pool.end().catch(() => undefined);
        await this.mongo?.close().catch(() => undefined);
    }
}

/** The in-memory environment of the dev fake driver (never in the production image). */
async function fakeEnvironments() {
    const [{ FakeEnvironmentRuntime }, { SCENARIOS }] = await Promise.all([import('@libs/runtime/environment'), import('../fake-cell/scenarios')]);
    const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
    return () => env;
}
