import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, EntitySchema } from 'typeorm';

import { EnqueueAstGraphUpdateOnMergedUseCase } from '@libs/code-review/application/use-cases/enqueue-ast-graph-update-on-merged.use-case';
import { AstGraphBuildJobProcessor } from '@libs/code-review/workflow/ast-graph-build-job.processor';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';

import { GraphIndexerService } from '../services/graph/graph-indexer.service';
import { RepositoryService } from '../services/repository.service';
import { AstGraphRepository, GraphNodeJson } from './astGraph.repository';
import { RepositoryRepository } from './repository.repository';
import { AstEdgeModel } from './schemas/astEdge.model';
import { AstNodeModel } from './schemas/astNode.model';
import { AstGraphStatus, RepositoryModel } from './schemas/repository.model';

const schema = `it_ast_state_${randomUUID().replace(/-/g, '')}`;
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
            columns: { uuid: { type: 'uuid', primary: true } },
        }),
    ],
    // Short like the app's 30s, so a defer that waits on a build's write
    // would time out without its own longer limit.
    extra: {
        options: `-c search_path=${schema},public -c statement_timeout=1000`,
    },
});

const run =
    process.env.SKIP_INTEGRATION !== 'true' &&
    (process.env.TEST_PG_PORT ||
        process.env.API_PG_DB_PORT ||
        process.env.CI === 'true');

async function waitForLockWaiter() {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        const [{ blocked }] = await db.query(
            "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock') AS blocked",
            [schema],
        );
        if (blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected the merge to wait on the build lock');
}

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

(run ? describe : describe.skip)('graph build state in Postgres', () => {
    const repoId = randomUUID();
    let graph: AstGraphRepository;
    let repositories: RepositoryService;
    const state = () =>
        db.getRepository(RepositoryModel).findOneOrFail({
            where: { uuid: repoId },
            select: {
                astGraphStatus: true,
                astGraphSha: true,
                astGraphMergedDuringBuild: true,
            },
        });

    beforeAll(async () => {
        await db.initialize();
        await db.query(`CREATE SCHEMA ${schema}`);
        await db.synchronize();
        graph = new AstGraphRepository(
            db.getRepository(AstNodeModel),
            db.getRepository(AstEdgeModel),
            db,
        );
        repositories = new RepositoryService(
            new RepositoryRepository(db.getRepository(RepositoryModel)),
        );
        await db.getRepository(RepositoryModel).insert({
            uuid: repoId,
            integrationConfigId: randomUUID(),
            externalId: '1',
            name: 'repo',
            fullName: 'org/repo',
            platform: PlatformType.GITHUB,
        });
    });
    afterAll(async () => {
        if (!db.isInitialized) return;
        try {
            await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
            await db.destroy();
        }
    });
    beforeEach(async () => {
        await graph.fullRebuild(repoId, [node('a')], [], { sha: 'base' });
        await db
            .getRepository(RepositoryModel)
            .update(repoId, { astGraphMergedDuringBuild: null });
    });

    describe('an incremental publication', () => {
        it('leaves a running full build in BUILDING', async () => {
            await graph.updateBuildStatus(repoId, AstGraphStatus.BUILDING);
            await graph.incrementalUpdate(
                repoId,
                ['src/a.ts'],
                [node('b')],
                [],
                {
                    sha: 'next',
                },
            );
            expect(await state()).toMatchObject({
                astGraphStatus: AstGraphStatus.BUILDING,
                astGraphSha: 'next',
            });
        });

        it('restores READY after a failed build', async () => {
            await graph.updateBuildStatus(repoId, AstGraphStatus.FAILED);
            await graph.incrementalUpdate(
                repoId,
                ['src/a.ts'],
                [node('b')],
                [],
                {
                    sha: 'next',
                },
            );
            expect(await state()).toMatchObject({
                astGraphStatus: AstGraphStatus.READY,
                astGraphSha: 'next',
            });
        });
    });

    describe('merges during a full build', () => {
        let dir: string;
        let commits: string[];
        let enqueued: any[];
        let failEnqueue: boolean;
        let merged: EnqueueAstGraphUpdateOnMergedUseCase;
        let processor: AstGraphBuildJobProcessor;
        const git = (...args: string[]) =>
            execFileSync('git', ['-C', dir, ...args], {
                encoding: 'utf8',
            }).trim();
        const sandbox = () =>
            ({
                repoDir: dir,
                run: async (command: string) => {
                    try {
                        return {
                            stdout: execFileSync('/bin/sh', ['-c', command], {
                                encoding: 'utf8',
                            }),
                            stderr: '',
                            exitCode: 0,
                        };
                    } catch (error) {
                        return {
                            stdout: '',
                            stderr: '',
                            exitCode: error.status,
                        };
                    }
                },
                readFile: async () =>
                    JSON.stringify({ nodes: [node('built')], edges: [] }),
            }) as never;
        const merge = (newSha: string) =>
            merged.execute({
                prNumber: 1,
                repoExternalId: '1',
                repoName: 'repo',
                platform: PlatformType.GITHUB,
                baseBranch: 'main',
                newSha,
                organizationAndTeamData: { organizationId: 'org' },
            });
        // The real indexer publishes the build, then the real processor
        // decides on the catch-up against the build's checkout.
        async function finishBuild(headSha: string) {
            const indexer = new GraphIndexerService(graph, {
                install: async () => {},
                parseAll: async () => ({ stderr: '' }),
            } as never);
            const checkout = sandbox();
            const deferred = await indexer.fullBuild({
                repositoryId: repoId,
                sandbox: checkout,
                headSha,
            });
            await processor.enqueueCatchUp(
                {
                    repositoryId: repoId,
                    cloneUrl: '',
                    defaultBranch: 'main',
                    fullName: 'org/repo',
                    platform: PlatformType.GITHUB,
                    organizationAndTeamData: { organizationId: 'org' },
                },
                checkout,
                headSha,
                deferred,
            );
        }

        beforeAll(() => {
            dir = mkdtempSync(join(tmpdir(), 'graph-build-state-'));
            execFileSync('git', ['init', '-q', '-b', 'main', dir]);
            git('config', 'user.email', 'test@example.org');
            git('config', 'user.name', 'test');
            commits = ['build', 'first merge', 'second merge'].map((msg) => {
                writeFileSync(join(dir, 'a.ts'), msg);
                git('add', '.');
                git('commit', '-qm', msg);
                return git('rev-parse', 'HEAD');
            });
        });
        afterAll(() => rmSync(dir, { recursive: true, force: true }));
        beforeEach(async () => {
            enqueued = [];
            failEnqueue = false;
            const queue = {
                enqueue: async (job: unknown) => {
                    if (failEnqueue) throw new Error('queue down');
                    enqueued.push(job);
                    return randomUUID();
                },
            };
            merged = new EnqueueAstGraphUpdateOnMergedUseCase(
                repositories,
                queue as never,
                {
                    getFilesByPullRequestId: async () => [
                        { filename: 'src/a.ts' },
                    ],
                } as never,
            );
            const unused = {} as never;
            processor = new AstGraphBuildJobProcessor(
                unused,
                unused,
                unused,
                unused,
                repositories,
                unused,
                queue as never,
            );
            await db
                .getRepository(RepositoryModel)
                .update(repoId, { defaultBranch: 'main' });
            await graph.updateBuildStatus(repoId, AstGraphStatus.BUILDING);
        });

        it('enqueues one catch-up to the latest merge the build missed', async () => {
            const deferred = {
                enqueued: false,
                reason: 'deferred until graph build finishes',
            };
            expect(await merge(commits[2])).toEqual(deferred);
            expect(await merge(commits[2])).toEqual(deferred);
            expect(enqueued).toEqual([]);
            expect((await state()).astGraphMergedDuringBuild).toBe(commits[2]);

            await finishBuild(commits[0]);

            expect(enqueued).toHaveLength(1);
            expect(enqueued[0]).toEqual({
                correlationId: repoId,
                workflowType: WorkflowType.AST_GRAPH_INCREMENTAL,
                handlerType: 'SIMPLE_FUNCTION',
                payload: {
                    repositoryId: repoId,
                    changedFiles: [],
                    newSha: commits[2],
                    cloneUrl: '',
                    defaultBranch: 'main',
                    fullName: 'org/repo',
                    platform: PlatformType.GITHUB,
                    organizationAndTeamData: { organizationId: 'org' },
                },
                status: 'PENDING',
                priority: 0,
                retryCount: 0,
                maxRetries: 3,
            });
            expect(await state()).toEqual({
                astGraphStatus: AstGraphStatus.READY,
                astGraphSha: commits[0],
                astGraphMergedDuringBuild: null,
            });

            // Once READY, a merge takes the normal incremental path again.
            expect(await merge(commits[2])).toMatchObject({
                enqueued: true,
                jobType: 'incremental',
            });
            expect(enqueued).toHaveLength(2);
        });

        it('enqueues nothing when the build already contains the merge', async () => {
            await merge(commits[1]);
            await finishBuild(commits[2]);

            expect(enqueued).toEqual([]);
            expect(await state()).toEqual({
                astGraphStatus: AstGraphStatus.READY,
                astGraphSha: commits[2],
                astGraphMergedDuringBuild: null,
            });
        });

        it('records a merge that waits on a build write longer than one lock attempt', async () => {
            const build = db.createQueryRunner();
            await build.connect();
            await build.startTransaction();
            await build.query('SET LOCAL statement_timeout = 0');
            await build.query(
                'SELECT 1 FROM repositories WHERE uuid = $1 FOR NO KEY UPDATE',
                [repoId],
            );
            const deferred = merge(commits[2]);
            // Hold the lock until the defer has waited on it and timed out
            // its first attempt, so the test covers the wait and the retry.
            await waitForLockWaiter();
            await new Promise((resolve) => setTimeout(resolve, 1200));
            await build.commitTransaction();
            await build.release();

            expect(await deferred).toEqual({
                enqueued: false,
                reason: 'deferred until graph build finishes',
            });
            expect((await state()).astGraphMergedDuringBuild).toBe(commits[2]);
        });

        it('catches up when merges arrive out of order', async () => {
            // The newer merge lands first; trusting the last one would see an
            // ancestor of the build head and skip the newer merge.
            await merge(commits[2]);
            await merge(commits[1]);
            expect((await state()).astGraphMergedDuringBuild).toBe('');

            await finishBuild(commits[1]);

            expect(enqueued).toHaveLength(1);
            expect(enqueued[0].payload.newSha).toBeUndefined();
            expect((await state()).astGraphMergedDuringBuild).toBeNull();
        });

        it('keeps the deferred merge when the catch-up cannot be queued', async () => {
            await merge(commits[2]);
            failEnqueue = true;

            await expect(finishBuild(commits[0])).rejects.toThrow(
                new Error('queue down'),
            );

            expect(await state()).toEqual({
                astGraphStatus: AstGraphStatus.READY,
                astGraphSha: commits[0],
                astGraphMergedDuringBuild: commits[2],
            });
        });

        it('a full snapshot from an incremental job does not finish the build', async () => {
            await merge(commits[2]);
            await graph.incrementalUpdate(repoId, undefined, [node('b')], [], {
                sha: commits[1],
            });
            expect(await state()).toEqual({
                astGraphStatus: AstGraphStatus.BUILDING,
                astGraphSha: commits[1],
                astGraphMergedDuringBuild: commits[2],
            });
        });

        it('enqueues nothing when no merge arrived during the build', async () => {
            await finishBuild(commits[0]);
            expect(enqueued).toEqual([]);
        });
    });
});
