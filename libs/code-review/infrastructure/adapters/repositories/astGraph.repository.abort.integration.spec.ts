import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

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
    entities: [RepositoryModel, AstNodeModel, AstEdgeModel],
    extra: { options: `-c search_path=${schema},public` },
});

const repoId = randomUUID();
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
            await graph.fullRebuild(repoId, oldNodes, oldEdges);
            await db.getRepository(RepositoryModel).update(repoId, {
                astGraphStatus: AstGraphStatus.READY,
                astGraphSha: 'old',
                astGraphNodeCount: 2,
                astGraphEdgeCount: 1,
            });
        });

        for (const kind of ['full', 'incremental'] as const) {
            function save(signal?: AbortSignal) {
                const revision = { sha: 'new', signal };
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
            it.each([
                ['node insert', /^INSERT INTO ast_nodes/],
                ['READY write', /^UPDATE .*"repositories"/],
            ] as const)(
                `${kind} save rolls back on abort after the %s`,
                async (_point, query) => {
                    const controller = new AbortController();
                    afterQuery = (sql) => {
                        if (query.test(sql)) controller.abort();
                    };
                    await expect(save(controller.signal)).rejects.toThrow();
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
