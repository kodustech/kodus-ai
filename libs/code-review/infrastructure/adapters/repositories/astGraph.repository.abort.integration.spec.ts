import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';
import { WorkflowJobRepository } from '@libs/core/workflow/infrastructure/repositories/workflow-job.repository';
import { StaleGraphJobError } from '@libs/code-review/domain/graph-job-attempt';

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
                metadata: { type: 'jsonb' },
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
                graph.updateBuildStatus(
                    repoId,
                    AstGraphStatus.BUILDING,
                    job,
                    controller.signal,
                ),
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
                    await db
                        .getRepository(WorkflowJobModel)
                        .update(
                            job.jobId,
                            condition === 'failed'
                                ? { status: JobStatus.FAILED }
                                : { metadata: { attemptId: randomUUID() } },
                        );
                    await expect(save()).rejects.toBeInstanceOf(
                        StaleGraphJobError,
                    );
                    await expect(
                        graph.updateBuildStatus(
                            repoId,
                            AstGraphStatus.BUILDING,
                            job,
                        ),
                    ).rejects.toBeInstanceOf(StaleGraphJobError);
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
                    expect(
                        await db
                            .getRepository(RepositoryModel)
                            .findOneBy({ uuid: repoId }),
                    ).toMatchObject({
                        astGraphSha: 'old',
                        astGraphNodeCount: 2,
                        astGraphEdgeCount: 1,
                    });
                    const stored = await graph.exportAsGraphJson(repoId);
                    expect(
                        stored.nodes.map((n) => n.qualified_name).sort(),
                    ).toEqual(['src/a.ts::callee', 'src/a.ts::caller']);
                    expect(stored.edges).toEqual([
                        expect.objectContaining(oldEdges[0]),
                    ]);
                },
            );
            it(`${kind} save publishes the new content, SHA and counts together`, async () => {
                await save();
                expect(
                    await db
                        .getRepository(RepositoryModel)
                        .findOneBy({ uuid: repoId }),
                ).toMatchObject({
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
