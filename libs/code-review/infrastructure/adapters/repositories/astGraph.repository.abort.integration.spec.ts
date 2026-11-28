import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'mongoose';
import { Sandbox } from 'e2b';
import { PlatformType } from '@libs/core/domain/enums';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';
import {
    SandboxLeaseModel,
    SandboxLeaseSchema,
} from '@libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model';
import { SandboxLeaseManager } from '@libs/sandbox/infrastructure/services/sandbox-lease-manager.service';
import { SandboxLeaseReaperService } from '@libs/sandbox/infrastructure/services/sandbox-lease-reaper.service';
import { resolveMongoTestGate } from '../../../../../test/integration/mongo-test-uri';
import { waitForSandboxRelease } from '../../../../../test/integration/sandbox/wait-for-sandbox-release';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobProcessorRouterService } from '@libs/core/workflow/infrastructure/job-processor-router.service';
import { WorkflowJobConsumer } from '@libs/core/workflow/infrastructure/workflow-job-consumer.service';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { RabbitMQErrorHandler } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';
import { GraphIndexerService } from '../services/graph/graph-indexer.service';

import { DataSource, EntitySchema } from 'typeorm';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';
import { WorkflowJobRepository } from '@libs/core/workflow/infrastructure/repositories/workflow-job.repository';
import { ClaimConflictError } from '@libs/core/workflow/domain/errors/claim-conflict.error';
import { graphCheckoutFiles } from '@libs/code-review/workflow/graph-checkout';
import { AstGraphBuildJobProcessor } from '@libs/code-review/workflow/ast-graph-build-job.processor';
import { AstGraphIncrementalJobProcessor } from '@libs/code-review/workflow/ast-graph-incremental-job.processor';
import { GraphJobSandbox } from '@libs/code-review/workflow/graph-job-sandbox';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { RecordedJobFailure } from '@libs/core/workflow/domain/errors/recorded-job-failure.error';
import { claimGraphJob } from '@libs/code-review/workflow/graph-job-stage';
import {
    AST_GRAPH_INCREMENTAL_TIMEOUT_MS,
    GraphBaselineChangedError,
    StaleGraphJobError,
} from '@libs/code-review/domain/graph-job-attempt';

import { AstGraphRepository, GraphNodeJson } from './astGraph.repository';
import { AstEdgeModel } from './schemas/astEdge.model';
import { AstNodeModel } from './schemas/astNode.model';
import { AstGraphStatus, RepositoryModel } from './schemas/repository.model';

const schema = `it_ast_abort_${randomUUID().replace(/-/g, '')}`;
const db = new DataSource({
    type: 'postgres',
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: Number(
        process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? 5432,
    ),
    username:
        process.env.TEST_PG_USER ??
        process.env.API_PG_DB_USERNAME ??
        'kodusdev',
    password:
        process.env.TEST_PG_PASSWORD ??
        process.env.API_PG_DB_PASSWORD ??
        'kodusdev',
    database:
        process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db',
    schema,
    applicationName: schema,
    entities: [
        RepositoryModel,
        AstNodeModel,
        AstEdgeModel,
        new EntitySchema<WorkflowJobModel>({
            name: 'WorkflowJobModel',
            target: WorkflowJobModel,
            tableName: 'workflow_jobs',
            schema,
            columns: {
                uuid: { type: 'uuid', primary: true },
                status: { type: 'varchar' },
                metadata: { type: 'jsonb', nullable: true },
                startedAt: { type: 'timestamp', nullable: true },
                currentStage: { type: 'varchar', nullable: true },
                payload: { type: 'jsonb', nullable: true },
                errorClassification: { type: 'varchar', nullable: true },
                lastError: { type: 'text', nullable: true },
                completedAt: { type: 'timestamp', nullable: true },
                workflowType: { type: 'varchar', nullable: true },
            },
        }),
    ],
    extra: { options: `-c search_path=${schema},public` },
});

function latch() {
    let open: () => void;
    const waiting = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { open, waiting };
}

async function waitForBlockedWriter() {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        const [{ blocked }] = await db.query(
            "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS blocked",
            [schema],
        );
        if (blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected a PostgreSQL writer to be waiting on a lock');
}

function graphConsumer(
    jobs: WorkflowJobRepository,
    incremental: AstGraphIncrementalJobProcessor,
    deadlineRouter?: JobProcessorRouterService,
) {
    const unused = {} as never;
    const router =
        deadlineRouter ??
        new JobProcessorRouterService(
            jobs,
            unused,
            unused,
            unused,
            unused,
            incremental,
            unused,
            unused,
        );
    return new WorkflowJobConsumer(
        router,
        {
            claim: async () => true,
            releaseIfHeldBy: async () => {},
            completeIfHeldBy: async () => {},
            releaseAllByInstance: async () => 0,
        } as never,
        jobs,
        {
            setContext: () => {},
            runInSpan: (_name, fn) => fn({ setAttributes: () => {} }),
        } as never,
        { protectTask: async () => {}, unprotectTask: async () => {} } as never,
    );
}

function readPublishedRevision(repoId: string) {
    return db.getRepository(RepositoryModel).findOneOrFail({
        select: {
            astGraphStatus: true,
            astGraphSha: true,
            astGraphNodeCount: true,
            astGraphEdgeCount: true,
        },
        where: { uuid: repoId },
    });
}

const repoId = randomUUID();
const job = { jobId: randomUUID(), attemptId: randomUUID() };

function node(name: string): GraphNodeJson {
    return {
        name,
        kind: 'function',
        qualified_name: `src/a.ts::${name}`,
        file_path: 'src/a.ts',
        line_start: 1,
        line_end: 2,
        language: 'typescript',
        is_test: false,
    };
}
const oldNodes = [node('caller'), node('callee')];
const oldEdges = [
    {
        kind: 'CALLS',
        source_qualified: oldNodes[0].qualified_name,
        target_qualified: oldNodes[1].qualified_name,
        file_path: 'src/a.ts',
        line: 2,
    },
];
const run =
    process.env.SKIP_INTEGRATION !== 'true' &&
    (process.env.TEST_PG_PORT ||
        process.env.API_PG_DB_PORT ||
        process.env.CI === 'true');

(run ? describe : describe.skip)(
    'publishing a graph revision in Postgres',
    () => {
        let graph: AstGraphRepository;
        let afterQuery: (query: string) => void;
        let beforeCommit: () => Promise<void>;
        beforeAll(async () => {
            await db.initialize();
            await db.query(`CREATE SCHEMA ${schema}`);
            await db.synchronize();
            graph = new AstGraphRepository(
                db.getRepository(AstNodeModel),
                db.getRepository(AstEdgeModel),
                db,
            );
            await db.getRepository(RepositoryModel).insert({
                uuid: repoId,
                integrationConfigId: randomUUID(),
                externalId: '1',
                name: 'repo',
                fullName: 'org/repo',
                platform: 'GITHUB',
            });
            db.subscribers.push({
                afterQuery: ({ query }) => afterQuery?.(query),
                beforeTransactionCommit: () => beforeCommit?.(),
            });
        });
        afterAll(async () => {
            if (db.isInitialized) {
                try {
                    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
                } finally {
                    await db.destroy();
                }
            }
        });
        beforeEach(async () => {
            afterQuery = undefined;
            beforeCommit = undefined;
            await db.getRepository(WorkflowJobModel).save({
                uuid: job.jobId,
                status: JobStatus.PROCESSING,
                metadata: { attemptId: job.attemptId },
            });
            await graph.fullRebuild(repoId, oldNodes, oldEdges);
            await db.getRepository(RepositoryModel).update(repoId, {
                astGraphStatus: AstGraphStatus.READY,
                astGraphSha: 'old',
                astGraphNodeCount: 2,
                astGraphEdgeCount: 1,
            });
        });

        it('advances the empty-diff SHA and retains every stored node, edge and count', async () => {
            const before = await graph.exportAsGraphJson(repoId);
            const indexer = new GraphIndexerService(graph, {} as never);
            await indexer.incrementalUpdate({
                repositoryId: repoId,
                sandbox: {} as never,
                changedFiles: [],
                expectedSha: 'old',
                newSha: 'identical-tree',
                job,
            });
            const after = await graph.exportAsGraphJson(repoId);
            expect(after.nodes).toEqual(before.nodes);
            expect(after.edges).toEqual(before.edges);
            expect(await readPublishedRevision(repoId)).toEqual({
                astGraphStatus: AstGraphStatus.READY,
                astGraphSha: 'identical-tree',
                astGraphNodeCount: 2,
                astGraphEdgeCount: 1,
            });
        });

        it('removes persisted submodule descendants and edges after a gitlink deletion', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'graph-gitlink-'));
            const git = (...args: string[]) =>
                execFileSync(
                    'git',
                    [
                        '-C',
                        dir,
                        '-c',
                        'user.name=Graph Test',
                        '-c',
                        'user.email=graph@example.org',
                        '-c',
                        'commit.gpgsign=false',
                        ...args,
                    ],
                    { encoding: 'utf8' },
                ).trim();
            try {
                git('init', '-q');
                git(
                    'commit',
                    '-q',
                    '--allow-empty',
                    '-m',
                    'object for gitlink',
                );
                const component = git('rev-parse', 'HEAD');
                git(
                    'update-index',
                    '--add',
                    '--cacheinfo',
                    `160000,${component},pkg/lib`,
                );
                git('commit', '-qm', 'tracked component');
                const base = git('rev-parse', 'HEAD');
                git('rm', '-q', '--cached', 'pkg/lib');
                git('commit', '-qm', 'removed component');
                git('config', 'diff.ignoreSubmodules', 'all');
                const head = git('rev-parse', 'HEAD');
                const descendant = {
                    ...node('removed'),
                    file_path: 'pkg/lib/old.ts',
                    qualified_name: 'pkg/lib/old.ts::removed',
                };
                const edge = {
                    ...oldEdges[0],
                    target_qualified: descendant.qualified_name,
                };
                await graph.fullRebuild(
                    repoId,
                    [oldNodes[0], descendant],
                    [edge],
                    { sha: base },
                );
                const sandbox = {
                    repoDir: dir,
                    run: async (command: string) => ({
                        stdout: execFileSync('/bin/sh', ['-c', command], {
                            encoding: 'utf8',
                        }),
                        exitCode: 0,
                    }),
                    readFile: async () =>
                        JSON.stringify({ nodes: [oldNodes[0]], edges: [] }),
                } as never;
                const changedFiles = await graphCheckoutFiles(
                    sandbox,
                    base,
                    head,
                );
                const indexer = new GraphIndexerService(graph, {
                    install: async () => {},
                    parseAll: async () => {},
                    parseFiles: async () => {},
                } as never);
                await indexer.incrementalUpdate({
                    repositoryId: repoId,
                    sandbox,
                    changedFiles,
                    newSha: head,
                    expectedSha: base,
                    job,
                });
                const stored = await graph.exportAsGraphJson(repoId);
                expect(stored.nodes.map((n) => [n.file_path, n.name])).toEqual([
                    ['src/a.ts', 'caller'],
                ]);
                expect(stored.edges).toEqual([]);
                expect(await readPublishedRevision(repoId)).toEqual({
                    astGraphStatus: AstGraphStatus.READY,
                    astGraphSha: head,
                    astGraphNodeCount: 1,
                    astGraphEdgeCount: 0,
                });
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('persists a terminal timestamp for a zero-node full build and clears it when reclaimed', async () => {
            const rows = db.getRepository(WorkflowJobModel);
            const jobs = new WorkflowJobRepository(rows);
            await rows.update(job.jobId, {
                status: JobStatus.PENDING,
                metadata: null,
                completedAt: null,
                lastError: null,
                workflowType: WorkflowType.AST_GRAPH_BUILD,
                payload: {
                    repositoryId: repoId,
                    fullName: 'org/repo',
                    defaultBranch: 'main',
                    platform: 'GITHUB',
                },
            });
            const sandbox = {
                repoDir: '/repo',
                run: async () => ({ stdout: 'empty-tree', exitCode: 0 }),
                readFile: async () => JSON.stringify({ nodes: [], edges: [] }),
            };
            const indexer = new GraphIndexerService(graph, {
                install: async () => {},
                parseAll: async () => ({ stderr: '' }),
            } as never);
            const processor = new AstGraphBuildJobProcessor(
                jobs,
                {
                    acquire: async () => ({
                        leaseId: 'lease',
                        sandboxId: 'sandbox',
                        wasCreated: true,
                        sandbox,
                    }),
                    release: async () => {},
                } as never,
                {
                    getCloneParams: async () => ({
                        url: 'https://example.org/repo',
                    }),
                } as never,
                indexer,
                {
                    findById: () =>
                        db
                            .getRepository(RepositoryModel)
                            .findOneByOrFail({ uuid: repoId }),
                } as never,
                new GraphJobSandbox(),
                { enqueue: async () => '' } as never,
            );
            await processor.process(job.jobId);
            const failed = await jobs.findOne(job.jobId);
            expect(failed.status).toBe(JobStatus.FAILED);
            expect(failed.currentStage).toBe('FAILED');
            expect(failed.completedAt).toBeInstanceOf(Date);
            expect(failed.lastError).toBe('Repository graph build failed');
            expect(await readPublishedRevision(repoId)).toEqual({
                astGraphStatus: AstGraphStatus.FAILED,
                astGraphSha: 'old',
                astGraphNodeCount: 2,
                astGraphEdgeCount: 1,
            });
            expect(
                await claimGraphJob(
                    jobs,
                    failed,
                    { jobId: job.jobId, attemptId: randomUUID() },
                    60000,
                ),
            ).toBe(true);
            expect(
                await rows.findOneOrFail({
                    where: { uuid: job.jobId },
                    select: {
                        status: true,
                        completedAt: true,
                        lastError: true,
                        errorClassification: true,
                    },
                }),
            ).toEqual({
                status: JobStatus.PROCESSING,
                completedAt: null,
                lastError: null,
                errorClassification: null,
            });
        });

        it.each([
            [JobStatus.COMPLETED, null],
            [JobStatus.PROCESSING, null],
            [JobStatus.FAILED, ErrorClassification.PERMANENT],
            [JobStatus.FAILED, ErrorClassification.RETRYABLE],
        ] as const)(
            'an expired graph deadline preserves a %s row with %s classification',
            async (finalStatus, classification) => {
                const rows = db.getRepository(WorkflowJobModel);
                const jobs = new WorkflowJobRepository(rows);
                const later = randomUUID();
                let expectedOwner: string;
                await rows.update(job.jobId, {
                    workflowType: WorkflowType.AST_GRAPH_INCREMENTAL,
                    status: JobStatus.PENDING,
                    metadata: null,
                    completedAt: null,
                    lastError: null,
                });
                const committed = latch();
                const finished = new Date('2026-01-01T00:00:00.000Z');
                const unused = {} as never;
                const router = new JobProcessorRouterService(
                    jobs,
                    unused,
                    unused,
                    unused,
                    unused,
                    {
                        process: async (
                            _jobId: string,
                            _signal: AbortSignal,
                            attemptId: string,
                        ) => {
                            expectedOwner =
                                finalStatus === JobStatus.PROCESSING
                                    ? later
                                    : attemptId;
                            await rows.update(job.jobId, {
                                lastError:
                                    finalStatus === JobStatus.FAILED
                                        ? 'earlier recorded failure'
                                        : null,
                                errorClassification: classification,
                                status: finalStatus,
                                metadata: { attemptId: expectedOwner },
                                completedAt:
                                    finalStatus === JobStatus.PROCESSING
                                        ? null
                                        : finished,
                            });
                            committed.open();
                            await new Promise(() => {});
                        },
                    } as never,
                    unused,
                    unused,
                );
                const nativeTimer = global.setTimeout;
                const timer = jest
                    .spyOn(global, 'setTimeout')
                    .mockImplementation(((
                        handler: (...values: unknown[]) => void,
                        ms: number,
                        ...args: unknown[]
                    ) =>
                        ms === AST_GRAPH_INCREMENTAL_TIMEOUT_MS
                            ? nativeTimer(() => {
                                  void committed.waiting.then(() =>
                                      handler(...args),
                                  );
                              }, 0)
                            : nativeTimer(
                                  handler,
                                  ms,
                                  ...args,
                              )) as typeof setTimeout);
                const consumer = graphConsumer(jobs, unused, router);
                try {
                    const delivery = consumer.handleAstGraphIncrementalJob(
                        { jobId: job.jobId },
                        {
                            properties: {
                                messageId: randomUUID(),
                                headers: {},
                            },
                        } as never,
                    );
                    if (classification === ErrorClassification.RETRYABLE)
                        await expect(delivery).rejects.toBeInstanceOf(
                            RecordedJobFailure,
                        );
                    else await delivery;
                } finally {
                    timer.mockRestore();
                }
                const stored = await jobs.findOne(job.jobId);
                expect(stored.status).toBe(finalStatus);
                expect(stored.lastError).toBe(
                    finalStatus === JobStatus.FAILED
                        ? 'earlier recorded failure'
                        : null,
                );
                expect(stored.errorClassification).toBe(classification);
                expect(stored.metadata.attemptId).toBe(expectedOwner);
                expect(stored.completedAt).toEqual(
                    finalStatus === JobStatus.PROCESSING ? null : finished,
                );
            },
        );

        const mongo = resolveMongoTestGate('graph_recovery');
        (mongo.shouldSkip ? it.skip : it).each([
            AstGraphBuildJobProcessor,
            AstGraphIncrementalJobProcessor,
        ])(
            '%p publishes the graph and reaps the abandoned sandbox after a worker dies holding its lease',
            async (Processor) => {
                const orgId = randomUUID(),
                    staleId = randomUUID(),
                    freshId = randomUUID();
                const mongoConnection = await createConnection(mongo.mongoUri, {
                    dbName: 'graph_crash_' + orgId.replace(/-/g, ''),
                }).asPromise();
                try {
                    const leaseRepo = new SandboxLeaseRepository(
                        mongoConnection.model(
                            SandboxLeaseModel.name,
                            SandboxLeaseSchema,
                        ),
                    );
                    const prKey = `${orgId}:${repoId}:graph:${job.jobId}`;
                    const config = new ConfigService({
                        API_E2B_KEY: 'fixture-api-key',
                    });
                    const cli = {
                        install: async () => {},
                        parseAll: async () => ({ stderr: '' }),
                    };
                    const fresh = {
                        type: 'e2b',
                        repoDir: '/repo',
                        remoteCommands: {},
                        sandboxId: freshId,
                        run: async () => ({
                            stdout: 'fresh-head',
                            exitCode: 0,
                        }),
                        readFile: async () =>
                            JSON.stringify({
                                nodes: [node('recovered')],
                                edges: [],
                            }),
                        cleanup: async () => {},
                    };
                    const provider = {
                        isAvailable: () => true,
                        createSandboxWithRepo: jest
                            .fn()
                            .mockResolvedValueOnce({
                                ...fresh,
                                sandboxId: staleId,
                            })
                            .mockResolvedValueOnce(fresh),
                    };
                    const deadWorker = new SandboxLeaseManager(
                        provider as never,
                        leaseRepo,
                        config,
                    );
                    await deadWorker.acquire(
                        prKey,
                        'graph-build',
                        2 * 60 * 60 * 1000,
                        {
                            cloneUrl: 'https://example.org/repo',
                            authToken: '',
                            branch: 'main',
                            platform: PlatformType.GITHUB,
                        },
                    );
                    expect(
                        (await leaseRepo.findByPrKey(prKey)).leaseCount,
                    ).toBe(1);
                    // This process never calls release or any shutdown hook.
                    const rows = db.getRepository(WorkflowJobModel);
                    const jobs = new WorkflowJobRepository(rows);
                    const full = Processor === AstGraphBuildJobProcessor;
                    await rows.update(job.jobId, {
                        status: JobStatus.PROCESSING,
                        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
                        metadata: { attemptId: randomUUID() },
                        workflowType: full
                            ? WorkflowType.AST_GRAPH_BUILD
                            : WorkflowType.AST_GRAPH_INCREMENTAL,
                        payload: {
                            repositoryId: repoId,
                            fullName: 'org/repo',
                            defaultBranch: 'main',
                            changedFiles: ['src/a.ts'],
                            newSha: 'fresh-head',
                            platform: 'GITHUB',
                            organizationAndTeamData: { organizationId: orgId },
                        },
                    });
                    if (full)
                        await db.getRepository(RepositoryModel).update(repoId, {
                            astGraphStatus: AstGraphStatus.BUILDING,
                        });
                    (Sandbox.connect as jest.Mock).mockResolvedValueOnce({
                        sandboxId: staleId,
                        commands: {
                            run: async () => ({
                                stdout: 'dead-head',
                                exitCode: 0,
                            }),
                        },
                    });
                    const retry = new Processor(
                        jobs,
                        new SandboxLeaseManager(
                            provider as never,
                            leaseRepo,
                            config,
                        ),
                        {
                            getCloneParams: async () => ({
                                url: 'https://example.org/repo',
                            }),
                        } as never,
                        new GraphIndexerService(graph, cli as never),
                        {
                            findById: () =>
                                db
                                    .getRepository(RepositoryModel)
                                    .findOneByOrFail({ uuid: repoId }),
                        } as never,
                        new GraphJobSandbox(),
                        { enqueue: async () => '' } as never,
                    );
                    await retry.process(job.jobId);
                    expect((await jobs.findOne(job.jobId)).status).toBe(
                        JobStatus.COMPLETED,
                    );
                    expect(await readPublishedRevision(repoId)).toEqual({
                        astGraphStatus: AstGraphStatus.READY,
                        astGraphSha: 'fresh-head',
                        astGraphNodeCount: 1,
                        astGraphEdgeCount: 0,
                    });
                    expect(
                        (await graph.exportAsGraphJson(repoId)).nodes.map(
                            (n) => n.name,
                        ),
                    ).toEqual(['recovered']);
                    expect(
                        provider.createSandboxWithRepo,
                    ).toHaveBeenCalledTimes(2);
                    const retiredKey = `${orgId}:retired:${staleId}`;
                    expect(
                        (
                            await leaseRepo.findByPrKey(retiredKey)
                        ).killAt.getTime(),
                    ).toBeLessThanOrEqual(Date.now());
                    const reaper = new SandboxLeaseReaperService(
                        leaseRepo,
                        {
                            acquire: async () => ({ release: async () => {} }),
                            release: async () => {},
                        } as never,
                        config,
                    );
                    await reaper.killIdleSandboxes();
                    expect(Sandbox.kill).toHaveBeenCalledWith(staleId, {
                        apiKey: 'fixture-api-key',
                    });
                    expect(await leaseRepo.findByPrKey(retiredKey)).toBeNull();
                    await waitForSandboxRelease(async () => {
                        expect(await leaseRepo.findByPrKey(prKey)).toBeNull();
                    });
                } finally {
                    await mongoConnection.dropDatabase();
                    await mongoConnection.close();
                }
            },
        );

        it.each([AstGraphBuildJobProcessor, AstGraphIncrementalJobProcessor])(
            '%p hands a shutdown-interrupted delivery to another worker',
            async (Processor) => {
                const full = Processor === AstGraphBuildJobProcessor;
                const rows = db.getRepository(WorkflowJobModel);
                const jobs = new WorkflowJobRepository(rows);
                const payload = {
                    repositoryId: repoId,
                    fullName: 'org/repo',
                    defaultBranch: 'main',
                    changedFiles: ['src/a.ts'],
                    newSha: 'tip',
                    platform: 'GITHUB',
                };
                await rows.update(job.jobId, {
                    status: JobStatus.PENDING,
                    metadata: null,
                    lastError: null,
                    workflowType: full
                        ? WorkflowType.AST_GRAPH_BUILD
                        : WorkflowType.AST_GRAPH_INCREMENTAL,
                    payload,
                });
                const status = full
                    ? AstGraphStatus.BUILDING
                    : AstGraphStatus.READY;
                await db
                    .getRepository(RepositoryModel)
                    .update(repoId, { astGraphStatus: status });
                const entered = latch(),
                    released = jest.fn().mockResolvedValue(undefined);
                const parser = async () => {
                    entered.open();
                    await new Promise<void>(() => {});
                };
                const processor = new Processor(
                    jobs,
                    {
                        acquire: async () => ({
                            leaseId: 'ours',
                            wasCreated: true,
                            sandboxId: 'active',
                            sandbox: {
                                repoDir: '/repo',
                                run: async () => ({
                                    stdout: 'tip',
                                    exitCode: 0,
                                }),
                            },
                        }),
                        release: released,
                    } as never,
                    {
                        getCloneParams: async () => ({
                            url: 'https://example.org/repo',
                        }),
                    } as never,
                    {
                        fullBuild: parser,
                        incrementalUpdate: parser,
                        failBuildForAttempt:
                            graph.failBuildForAttempt.bind(graph),
                    } as never,
                    {
                        findById: () =>
                            db
                                .getRepository(RepositoryModel)
                                .findOneByOrFail({ uuid: repoId }),
                    } as never,
                    new GraphJobSandbox(),
                    { enqueue: async () => '' } as never,
                );
                const unused = {} as never;
                const router = new JobProcessorRouterService(
                    jobs,
                    unused,
                    unused,
                    unused,
                    processor as AstGraphBuildJobProcessor,
                    processor as AstGraphIncrementalJobProcessor,
                    unused,
                    unused,
                );
                const consumer = graphConsumer(jobs, unused, router);
                const handle = (
                    full
                        ? consumer.handleAstGraphBuildJob
                        : consumer.handleAstGraphIncrementalJob
                ).bind(consumer);
                const delivery = handle({ jobId: job.jobId }, {
                    properties: { messageId: randomUUID(), headers: {} },
                } as never);
                await entered.waiting;
                const shutdown = consumer.beforeApplicationShutdown('SIGTERM');
                const interruptedDelivery = await delivery.catch(
                    (error) => error,
                );
                expect(interruptedDelivery).toBeInstanceOf(ClaimConflictError);
                expect({
                    message: interruptedDelivery.message,
                    classification: interruptedDelivery.errorClassification,
                    delay: interruptedDelivery.requeueDelayMs,
                    returnToQueue: interruptedDelivery.returnToQueue,
                }).toEqual({
                    message: 'Graph worker is shutting down',
                    classification: 'CLAIM_HELD',
                    delay: 20_000,
                    returnToQueue: true,
                });

                await shutdown;
                expect(released.mock.calls).toEqual([['ours', { idleMs: 0 }]]);
                const interrupted = await jobs.findOne(job.jobId);
                expect(interrupted.status).toBe(JobStatus.FAILED);
                expect(interrupted.errorClassification).toBe(
                    ErrorClassification.RETRYABLE,
                );
                expect(await readPublishedRevision(repoId)).toEqual({
                    astGraphStatus: status,
                    astGraphSha: 'old',
                    astGraphNodeCount: 2,
                    astGraphEdgeCount: 1,
                });
                expect(
                    await claimGraphJob(
                        jobs,
                        interrupted,
                        { jobId: job.jobId, attemptId: randomUUID() },
                        60000,
                    ),
                ).toBe(true);
            },
        );

        it('serializes disjoint updates before they count the published rows', async () => {
            const entered = latch(),
                release = latch();
            beforeCommit = async () => {
                beforeCommit = undefined;
                entered.open();
                await release.waiting;
            };
            const append = (file: string) =>
                graph.incrementalUpdate(
                    repoId,
                    [file],
                    [{ ...node(file), file_path: file }],
                    [],
                    { sha: file },
                );
            const first = append('b.ts');
            await entered.waiting;
            const second = append('c.ts');
            try {
                await waitForBlockedWriter();
            } finally {
                release.open();
                await Promise.all([first, second]);
            }
            expect(
                await db
                    .getRepository(RepositoryModel)
                    .findOneByOrFail({ uuid: repoId }),
            ).toMatchObject({
                astGraphSha: 'c.ts',
                astGraphNodeCount: 4,
                astGraphEdgeCount: 1,
            });
            expect((await graph.exportAsGraphJson(repoId)).nodes).toHaveLength(
                4,
            );
        });

        it('retries an older checkout without replacing rows or losing disjoint changes', async () => {
            const update = (
                file: string,
                expectedSha: string,
                sha: string,
                name: string,
            ) =>
                graph.incrementalUpdate(
                    repoId,
                    [file],
                    [{ ...node(name), file_path: file }],
                    [],
                    { expectedSha, sha },
                );
            await update('src/a.ts', 'old', 'newer', 'new-content');
            await expect(
                graph.updateBuildStatus(repoId, AstGraphStatus.BUILDING, {
                    expectedSha: 'old',
                    sha: 'older',
                    job,
                }),
            ).rejects.toBeInstanceOf(GraphBaselineChangedError);
            expect((await readPublishedRevision(repoId)).astGraphStatus).toBe(
                AstGraphStatus.READY,
            );
            const late = update('src/a.ts', 'old', 'older', 'stale-content');
            await expect(late).rejects.toBeInstanceOf(
                GraphBaselineChangedError,
            );
            // A retry reparses this event's paths on the latest default-branch checkout.
            await update('src/b.ts', 'newer', 'newer', 'separate-change');
            const stored = await graph.exportAsGraphJson(repoId);
            expect(stored.nodes.map((n) => n.name).sort()).toEqual([
                'new-content',
                'separate-change',
            ]);
            expect(
                (
                    await db
                        .getRepository(RepositoryModel)
                        .findOneByOrFail({ uuid: repoId })
                ).astGraphSha,
            ).toBe('newer');
        });

        it.each([
            ['replacement', undefined],
            [
                'a provider failure',
                new Error('private-provider-query', {
                    cause: { code: 'ECONNRESET' },
                }),
            ],
            [
                'a final connection reset after an earlier 403',
                Object.assign(new Error('provider exhausted retries'), {
                    lastError: { code: 'ECONNRESET' },
                    errors: [{ response: { status: 403 } }],
                }),
            ],
        ] as const)(
            'persists the incremental processor outcome for %s',
            async (_condition, providerError) => {
                const rows = db.getRepository(WorkflowJobModel);
                const jobs = new WorkflowJobRepository(rows);
                const replacementId = randomUUID();
                await rows.update(job.jobId, {
                    status: JobStatus.PENDING,
                    metadata: null,
                    errorClassification: null,
                    lastError: null,
                    payload: {
                        repositoryId: repoId,
                        fullName: 'org/repo',
                        defaultBranch: 'main',
                        platform: 'GITHUB',
                        changedFiles: ['src/a.ts'],
                    },
                });
                const processor = new AstGraphIncrementalJobProcessor(
                    jobs,
                    {
                        acquire: async () => ({
                            leaseId: 'lease',
                            sandboxId: 'sandbox',
                            wasCreated: true,
                            sandbox: {
                                repoDir: '/repo',
                                run: async () => ({
                                    stdout: 'candidate',
                                    exitCode: 0,
                                }),
                            },
                        }),
                        release: async () => {},
                    } as never,
                    {
                        getCloneParams: async () => ({
                            url: 'https://example.org/repo',
                        }),
                    } as never,
                    {
                        incrementalUpdate: async ({ job: writing }) => {
                            if (providerError) throw providerError;
                            await rows.update(job.jobId, {
                                status: JobStatus.PROCESSING,
                                metadata: { attemptId: replacementId },
                            });
                            await graph.incrementalUpdate(
                                repoId,
                                ['src/a.ts'],
                                [node('late')],
                                [],
                                { sha: 'candidate', job: writing },
                            );
                        },
                    } as never,
                    {
                        findById: () =>
                            db
                                .getRepository(RepositoryModel)
                                .findOneByOrFail({ uuid: repoId }),
                    } as never,
                    new GraphJobSandbox(),
                );
                const processing = processor.process(job.jobId);
                if (providerError) {
                    const failure = await processing.catch((error) => error);
                    expect(
                        await rows.findOneOrFail({
                            where: { uuid: job.jobId },
                            select: {
                                status: true,
                                lastError: true,
                                errorClassification: true,
                            },
                        }),
                    ).toEqual({
                        status: JobStatus.FAILED,
                        lastError:
                            'Repository graph incremental update failed temporarily',
                        errorClassification: ErrorClassification.RETRYABLE,
                    });
                    expect(failure).toBeInstanceOf(RecordedJobFailure);
                } else {
                    await processing;
                    expect(
                        await rows.findOneOrFail({
                            where: { uuid: job.jobId },
                            select: { status: true, metadata: true },
                        }),
                    ).toEqual({
                        status: JobStatus.PROCESSING,
                        metadata: { attemptId: replacementId },
                    });
                }
                expect(
                    (
                        await db
                            .getRepository(RepositoryModel)
                            .findOneByOrFail({ uuid: repoId })
                    ).astGraphSha,
                ).toBe('old');
                expect(
                    (await graph.exportAsGraphJson(repoId)).nodes
                        .map((n) => n.name)
                        .sort(),
                ).toEqual(['callee', 'caller']);
            },
        );

        it.each(['recorded', 'held'] as const)(
            'keeps the stored job after the router and consumer rethrow a %s error',
            async (kind) => {
                const rows = db.getRepository(WorkflowJobModel);
                const jobs = new WorkflowJobRepository(rows);
                const error =
                    kind === 'recorded'
                        ? new RecordedJobFailure(
                              'Repository graph incremental update failed temporarily',
                          )
                        : new ClaimConflictError();
                const stored = {
                    status:
                        kind === 'recorded'
                            ? JobStatus.FAILED
                            : JobStatus.PROCESSING,
                    metadata: { attemptId: randomUUID() },
                    lastError: kind === 'recorded' ? error.message : null,
                    errorClassification:
                        kind === 'recorded'
                            ? ErrorClassification.RETRYABLE
                            : null,
                };
                await rows.update(job.jobId, {
                    ...stored,
                    workflowType: WorkflowType.AST_GRAPH_INCREMENTAL,
                });
                const consumer = graphConsumer(jobs, {
                    process: async () => {
                        throw error;
                    },
                } as never);
                await expect(
                    consumer.handleAstGraphIncrementalJob(
                        { jobId: job.jobId },
                        {
                            properties: {
                                messageId: randomUUID(),
                                headers: {},
                            },
                        } as never,
                    ),
                ).rejects.toBe(error);
                expect(
                    await rows.findOneOrFail({
                        where: { uuid: job.jobId },
                        select: {
                            status: true,
                            metadata: true,
                            lastError: true,
                            errorClassification: true,
                        },
                    }),
                ).toEqual(stored);
            },
        );

        it('requeues a conflicting merge and publishes all changes from the fresh Git checkout', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'graph-merge-'));
            const stale = join(dir, 'first');
            const checkout = join(dir, 'current');
            const git = (cwd: string, ...args: string[]) =>
                execFileSync(
                    'git',
                    [
                        '-C',
                        cwd,
                        '-c',
                        'user.name=Graph Test',
                        '-c',
                        'user.email=graph@example.org',
                        '-c',
                        'commit.gpgsign=false',
                        ...args,
                    ],
                    { encoding: 'utf8' },
                ).trim();
            const commit = (file: string, value: string) => {
                writeFileSync(join(checkout, file), value);
                git(checkout, 'add', '--', file);
                git(checkout, 'commit', '-qm', 'update ' + file);
                return git(checkout, 'rev-parse', 'HEAD');
            };
            const symbol = (file: string, content: string) => ({
                ...node(content),
                file_path: file,
                qualified_name: file + '::' + content,
            });
            try {
                execFileSync('git', ['init', '-q', checkout]);
                const base = commit('a.ts', 'a0');
                const first = commit('a.ts', 'a1');
                git(
                    checkout,
                    'worktree',
                    'add',
                    '-q',
                    '--detach',
                    stale,
                    first,
                );
                const middle = commit('b.ts', 'b1');
                commit('c.ts', 'c1');
                const latest = commit('d.ts', 'd1');
                await graph.fullRebuild(repoId, [symbol('a.ts', 'a0')], [], {
                    sha: base,
                });
                const rows = db.getRepository(WorkflowJobModel);
                const jobs = new WorkflowJobRepository(rows);
                await rows.update(job.jobId, {
                    workflowType: WorkflowType.AST_GRAPH_INCREMENTAL,
                    status: JobStatus.PENDING,
                    metadata: null,
                    payload: {
                        repositoryId: repoId,
                        fullName: 'org/repo',
                        defaultBranch: 'main',
                        platform: 'GITHUB',
                        changedFiles: ['a.ts'],
                        newSha: first,
                    },
                });
                const parsed: string[][] = [];
                let output = '';
                const indexer = new GraphIndexerService(graph, {
                    install: async () => {},
                    parseFiles: async (sandbox, files: string[]) => {
                        parsed.push(files);
                        output = JSON.stringify({
                            nodes: files.map((file) =>
                                symbol(
                                    file,
                                    readFileSync(
                                        join(sandbox.repoDir, file),
                                        'utf8',
                                    ),
                                ),
                            ),
                            edges: [],
                        });
                        if (sandbox.repoDir === stale)
                            await graph.fullRebuild(
                                repoId,
                                [symbol('a.ts', 'a1'), symbol('b.ts', 'b1')],
                                [],
                                { sha: middle },
                            );
                    },
                } as never);
                const dirs = [stale, checkout];
                const processor = new AstGraphIncrementalJobProcessor(
                    jobs,
                    {
                        acquire: async () => {
                            const repoDir = dirs.shift();
                            return {
                                leaseId: repoDir,
                                sandboxId: repoDir,
                                wasCreated: true,
                                sandbox: {
                                    repoDir,
                                    run: async (command: string) => ({
                                        stdout: execFileSync(
                                            '/bin/sh',
                                            ['-c', command],
                                            { encoding: 'utf8' },
                                        ),
                                        exitCode: 0,
                                    }),
                                    readFile: async () => output,
                                },
                            };
                        },
                        release: async () => {},
                    } as never,
                    {
                        getCloneParams: async () => ({
                            url: 'https://example.org/repo',
                        }),
                    } as never,
                    indexer,
                    {
                        findById: () =>
                            db
                                .getRepository(RepositoryModel)
                                .findOneByOrFail({ uuid: repoId }),
                    } as never,
                    new GraphJobSandbox(),
                );
                const consumer = graphConsumer(jobs, processor);
                const payload = { jobId: job.jobId };
                const envelope = {
                    properties: {
                        messageId: randomUUID(),
                        headers: { 'x-retry-count': 1 },
                    },
                    fields: {
                        exchange: 'workflow.exchange',
                        routingKey: 'workflow.jobs.org.AST_GRAPH_INCREMENTAL',
                    },
                    content: Buffer.from(JSON.stringify(payload)),
                };
                const firstDelivery = consumer.handleAstGraphIncrementalJob(
                    payload,
                    envelope as never,
                );
                await expect(firstDelivery).rejects.toBeInstanceOf(
                    GraphBaselineChangedError,
                );
                const error = await firstDelivery.catch((e) => e);
                const publish = jest.fn().mockResolvedValue(undefined);
                const handler = new RabbitMQErrorHandler(
                    { publish } as never,
                    { get: () => undefined } as never,
                );
                await handler.handle(
                    { ack: jest.fn() },
                    envelope as never,
                    error,
                );
                expect(publish).toHaveBeenCalledTimes(1);
                const [exchange, routingKey, body, options] =
                    publish.mock.calls[0];
                expect([
                    exchange,
                    routingKey,
                    options.headers['x-retry-count'],
                ]).toEqual([
                    'workflow.exchange.delayed',
                    envelope.fields.routingKey,
                    1,
                ]);
                const retry = JSON.parse(body.toString());
                await consumer.handleAstGraphIncrementalJob(retry, {
                    ...envelope,
                    properties: options,
                } as never);
                expect(parsed).toEqual([['a.ts'], ['c.ts', 'd.ts']]);
                expect((await jobs.findOne(job.jobId)).status).toBe(
                    JobStatus.COMPLETED,
                );
                expect(await readPublishedRevision(repoId)).toEqual({
                    astGraphStatus: AstGraphStatus.READY,
                    astGraphSha: latest,
                    astGraphNodeCount: 4,
                    astGraphEdgeCount: 0,
                });
                expect(
                    (await graph.exportAsGraphJson(repoId)).nodes
                        .map((n) => [n.file_path, n.name])
                        .sort(),
                ).toEqual([
                    ['a.ts', 'a1'],
                    ['b.ts', 'b1'],
                    ['c.ts', 'c1'],
                    ['d.ts', 'd1'],
                ]);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('claims only the observed attempt, keeps live work and reclaims after the deadline', async () => {
            const rows = db.getRepository(WorkflowJobModel);
            const jobs = new WorkflowJobRepository(rows);
            await rows.update(job.jobId, {
                status: JobStatus.PENDING,
                metadata: null,
            });
            const pending = await jobs.findOne(job.jobId);
            const stale = { jobId: job.jobId, attemptId: randomUUID() };
            expect(await claimGraphJob(jobs, pending, job, 60_000)).toBe(true);
            expect(await claimGraphJob(jobs, pending, stale, 60_000)).toBe(
                false,
            );
            const live = await jobs.findOne(job.jobId);
            await expect(
                claimGraphJob(jobs, live, stale, 60_000),
            ).rejects.toBeInstanceOf(ClaimConflictError);
            await rows.update(job.jobId, {
                startedAt: new Date(Date.now() - 120_000),
            });
            const expired = await jobs.findOne(job.jobId);
            const next = { jobId: job.jobId, attemptId: randomUUID() };
            expect(await claimGraphJob(jobs, expired, next, 60_000)).toBe(true);
            expect(await claimGraphJob(jobs, expired, stale, 60_000)).toBe(
                false,
            );
            expect((await jobs.findOne(job.jobId)).metadata).toEqual({
                attemptId: next.attemptId,
                stage: 'VALIDATING',
            });
            await rows.update(job.jobId, { status: JobStatus.FAILED });
            expect(
                await claimGraphJob(
                    jobs,
                    await jobs.findOne(job.jobId),
                    stale,
                    60_000,
                ),
            ).toBe(true);
        });

        it('only the failed owner can fail a build and a published graph stays ready', async () => {
            const rows = db.getRepository(WorkflowJobModel);
            const repos = db.getRepository(RepositoryModel);
            await rows.update(job.jobId, { status: JobStatus.FAILED });
            await graph.failBuildForAttempt(repoId, job);
            expect(
                (await repos.findOneByOrFail({ uuid: repoId })).astGraphStatus,
            ).toBe(AstGraphStatus.READY);
            await repos.update(repoId, {
                astGraphStatus: AstGraphStatus.BUILDING,
            });
            await graph.failBuildForAttempt(repoId, job);
            expect(
                (await repos.findOneByOrFail({ uuid: repoId })).astGraphStatus,
            ).toBe(AstGraphStatus.FAILED);
            const replacement = { jobId: job.jobId, attemptId: randomUUID() };
            await rows.update(job.jobId, {
                status: JobStatus.PROCESSING,
                metadata: { attemptId: replacement.attemptId },
            });
            await graph.updateBuildStatus(repoId, AstGraphStatus.BUILDING, {
                job: replacement,
            });
            await expect(
                graph.failBuildForAttempt(repoId, job),
            ).rejects.toBeInstanceOf(StaleGraphJobError);
            expect(
                (await repos.findOneByOrFail({ uuid: repoId })).astGraphStatus,
            ).toBe(AstGraphStatus.BUILDING);
        });

        it('orders a failure after a publication already committing', async () => {
            const entered = latch(),
                release = latch();
            const controller = new AbortController();
            beforeCommit = async () => {
                beforeCommit = undefined;
                entered.open();
                await release.waiting;
            };
            const saving = graph.fullRebuild(repoId, [node('committed')], [], {
                sha: 'committed',
                job,
                signal: controller.signal,
            });
            await entered.waiting;
            controller.abort();
            const jobs = db.getRepository(WorkflowJobModel);
            const failing = jobs.update(job.jobId, {
                status: JobStatus.FAILED,
            });
            try {
                await waitForBlockedWriter();
                expect(
                    (await jobs.findOneByOrFail({ uuid: job.jobId })).status,
                ).toBe(JobStatus.PROCESSING);
            } finally {
                release.open();
                await Promise.all([saving, failing]);
            }
            expect(
                (await jobs.findOneByOrFail({ uuid: job.jobId })).status,
            ).toBe(JobStatus.FAILED);
            expect(
                (
                    await db
                        .getRepository(RepositoryModel)
                        .findOneByOrFail({ uuid: repoId })
                ).astGraphSha,
            ).toBe('committed');
        });

        it('keeps FAILED when a completion already waiting on the job row resumes', async () => {
            const jobs = db.getRepository(WorkflowJobModel);
            const repository = new WorkflowJobRepository(jobs);
            const lock = db.createQueryRunner();
            await lock.startTransaction();
            try {
                await lock.manager.update(WorkflowJobModel, job.jobId, {
                    status: JobStatus.FAILED,
                });
                const finishing = repository.update(
                    job.jobId,
                    { status: JobStatus.COMPLETED },
                    JobStatus.PROCESSING,
                    job.attemptId,
                );
                try {
                    await waitForBlockedWriter();
                } finally {
                    await lock.commitTransaction();
                    await finishing;
                }
                expect(
                    (await jobs.findOneByOrFail({ uuid: job.jobId })).status,
                ).toBe(JobStatus.FAILED);
            } finally {
                if (lock.isTransactionActive) await lock.rollbackTransaction();
                await lock.release();
            }
        });

        it('rolls back a BUILDING write that completes after cancellation', async () => {
            const controller = new AbortController();
            const reason = new Error('cancel building');
            afterQuery = (sql) => {
                if (/^UPDATE .*"repositories"/.test(sql))
                    controller.abort(reason);
            };
            await expect(
                graph.updateBuildStatus(repoId, AstGraphStatus.BUILDING, {
                    job,
                    signal: controller.signal,
                }),
            ).rejects.toBe(reason);
            expect(
                (
                    await db
                        .getRepository(RepositoryModel)
                        .findOneByOrFail({ uuid: repoId })
                ).astGraphStatus,
            ).toBe(AstGraphStatus.READY);
        });

        for (const kind of ['full', 'incremental'] as const) {
            function save(signal?: AbortSignal) {
                const revision = { sha: 'new', signal, job };
                return kind === 'full'
                    ? graph.fullRebuild(
                          repoId,
                          [node('replacement')],
                          [],
                          revision,
                      )
                    : graph.incrementalUpdate(
                          repoId,
                          ['src/a.ts'],
                          [node('replacement')],
                          [],
                          revision,
                      );
            }
            it.each(['failed', 'replaced'])(
                `${kind} refuses publication by a %s attempt`,
                async (condition) => {
                    const replacementId = randomUUID();
                    const rows = db.getRepository(WorkflowJobModel);
                    await rows.update(
                        job.jobId,
                        condition === 'failed'
                            ? { status: JobStatus.FAILED }
                            : { metadata: { attemptId: replacementId } },
                    );
                    await expect(save()).rejects.toBeInstanceOf(
                        StaleGraphJobError,
                    );
                    await expect(
                        graph.updateBuildStatus(
                            repoId,
                            AstGraphStatus.BUILDING,
                            { job },
                        ),
                    ).rejects.toBeInstanceOf(StaleGraphJobError);
                    if (condition === 'replaced') {
                        const jobs = new WorkflowJobRepository(rows);
                        await jobs.update(
                            job.jobId,
                            { status: JobStatus.FAILED },
                            JobStatus.PROCESSING,
                            job.attemptId,
                        );
                        expect(
                            await rows.findOneOrFail({
                                select: { status: true, metadata: true },
                                where: { uuid: job.jobId },
                            }),
                        ).toEqual({
                            status: JobStatus.PROCESSING,
                            metadata: { attemptId: replacementId },
                        });
                    }
                    expect(
                        (
                            await db
                                .getRepository(RepositoryModel)
                                .findOneByOrFail({ uuid: repoId })
                        ).astGraphSha,
                    ).toBe('old');
                    expect(
                        (await graph.exportAsGraphJson(repoId)).nodes
                            .map((n) => n.name)
                            .sort(),
                    ).toEqual(['callee', 'caller']);
                },
            );

            it(`${kind} stops after an aborted chunk before sending more writes or counts`, async () => {
                const controller = new AbortController();
                const reason = new Error('cancel first chunk');
                const remaining: string[] = [];
                afterQuery = (sql) => {
                    if (
                        controller.signal.aborted &&
                        /^(INSERT|DELETE|SELECT|UPDATE)/.test(sql)
                    )
                        remaining.push(sql.slice(0, 40));
                    if (sql.startsWith('INSERT INTO ast_nodes'))
                        controller.abort(reason);
                };
                const rows = Array.from({ length: 4700 }, (_, i) =>
                    node(String(i)),
                );
                const revision = {
                    sha: 'large',
                    signal: controller.signal,
                    job,
                };
                const writing =
                    kind === 'full'
                        ? graph.fullRebuild(repoId, rows, oldEdges, revision)
                        : graph.incrementalUpdate(
                              repoId,
                              ['src/a.ts'],
                              rows,
                              oldEdges,
                              revision,
                          );
                await expect(writing).rejects.toBe(reason);
                expect(remaining).toEqual([]);
            });
            it.each([
                ['node insert', /^INSERT INTO ast_nodes/],
                ['READY write', /^UPDATE .*"repositories"/],
            ] as const)(
                `${kind} save rolls back on abort after the %s`,
                async (_point, query) => {
                    const controller = new AbortController();
                    const reason = new Error('graph job timed out');
                    afterQuery = (sql) => {
                        if (query.test(sql)) controller.abort(reason);
                    };
                    await expect(save(controller.signal)).rejects.toBe(reason);
                    expect(controller.signal.aborted).toBe(true);
                    expect(await readPublishedRevision(repoId)).toEqual({
                        astGraphStatus: AstGraphStatus.READY,
                        astGraphSha: 'old',
                        astGraphNodeCount: 2,
                        astGraphEdgeCount: 1,
                    });
                    const stored = await graph.exportAsGraphJson(repoId);
                    expect(
                        stored.nodes.map((n) => n.qualified_name).sort(),
                    ).toEqual(['src/a.ts::callee', 'src/a.ts::caller']);
                    expect(stored.edges).toEqual(oldEdges);
                },
            );
            it(`${kind} save publishes the new content, SHA and counts together`, async () => {
                await save();
                expect(await readPublishedRevision(repoId)).toEqual({
                    astGraphStatus: AstGraphStatus.READY,
                    astGraphSha: 'new',
                    astGraphNodeCount: 1,
                    astGraphEdgeCount: 0,
                });
                const stored = await graph.exportAsGraphJson(repoId);
                expect(stored.nodes.map((n) => n.name)).toEqual([
                    'replacement',
                ]);
                expect(stored.edges).toEqual([]);
            });
        }
    },
);
