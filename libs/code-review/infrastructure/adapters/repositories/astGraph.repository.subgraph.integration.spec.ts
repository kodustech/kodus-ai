/**
 * INTEGRATION TEST — AstGraphRepository.exportSubgraphJsonString against a
 * real Postgres.
 *
 * The subgraph query used to select edges with
 * `source_qualified IN (...) OR target_qualified IN (...)`, which Postgres
 * cannot serve from idx_ast_edges_repo_source/_target: it read every edge of
 * the repo and filtered them (prod 2026-11-23: p50 6.6s, 30s timeouts on PRs
 * that changed 1 file). The query now joins each endpoint on its index and
 * merges with UNION. This file pins:
 *   1. the same nodes and edges as the previous query, for changed files that
 *      hit plain calls, inheritance (parents and siblings) and an edge whose
 *      both endpoints changed;
 *   2. no OR of hashed subplans left in the plan.
 *
 * It creates its own schema with the ast_* tables and indexes of migrations
 * 1775690886942-AstGraphTables and 1775700127371-AddAstEdgesRepoTargetIndex,
 * so it needs no migrated database. Locally, an unreachable Postgres skips the
 * suite with a warning; in CI it fails.
 */
require('dotenv').config();

import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AstGraphRepository } from './astGraph.repository';

const schema = `it_astgraph_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

const connection = {
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: parseInt(
        process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
        10,
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
};

const dataSource = new DataSource({
    type: 'postgres',
    ...connection,
    logging: false,
    synchronize: false,
    entities: [],
    // Every query of this suite, the repository's included, resolves the
    // unqualified ast_* tables in the suite's own schema.
    extra: { options: `-c search_path=${schema}` },
});

const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';
// CI fails on an unreachable Postgres instead of skipping. Any CI marker
// counts (CI=true, CI=1, ...) except an explicit false or 0.
const ciMarker = (process.env.CI ?? '').trim().toLowerCase();
const runningInCi = ciMarker !== '' && ciMarker !== 'false' && ciMarker !== '0';

/** A plan line that filters with an OR of two subplans (the old shape). */
function hasOrOfSubplans(plan: string): boolean {
    return plan
        .split('\n')
        .some(
            (line) =>
                line.includes('Filter:') &&
                line.includes(' OR ') &&
                (line.match(/SubPlan/g) ?? []).length >= 2,
        );
}

/** The subgraph query before the fix, for comparison. */
const PREVIOUS_SUBGRAPH_SQL = `WITH changed_nodes AS (
        SELECT qualified_name FROM ast_nodes
        WHERE repo_id = $1 AND file_path = ANY($3::text[])
    ),
    touching_edges AS (
        SELECT e.* FROM ast_edges e
        WHERE e.repo_id = $1
          AND (
              e.source_qualified IN (SELECT qualified_name FROM changed_nodes)
              OR e.target_qualified IN (SELECT qualified_name FROM changed_nodes)
          )
    ),
    parent_classes AS (
        SELECT DISTINCT e.target_qualified AS qn FROM touching_edges e
        WHERE e.kind = 'INHERITS'
    ),
    sibling_classes AS (
        SELECT DISTINCT e.source_qualified AS qn FROM ast_edges e
        WHERE e.repo_id = $1 AND e.kind = 'INHERITS'
          AND e.target_qualified IN (SELECT qn FROM parent_classes)
    ),
    sibling_edges AS (
        SELECT e.* FROM ast_edges e
        WHERE e.repo_id = $1 AND e.kind IN ('INHERITS', 'CONTAINS')
          AND (
              e.source_qualified IN (SELECT qn FROM sibling_classes)
              OR e.target_qualified IN (SELECT qn FROM sibling_classes)
          )
    ),
    all_edges AS (
        SELECT * FROM touching_edges UNION SELECT * FROM sibling_edges
    ),
    neighbor_qnames AS (
        SELECT DISTINCT source_qualified AS qn FROM all_edges
        UNION
        SELECT DISTINCT target_qualified AS qn FROM all_edges
    ),
    all_relevant_nodes AS (
        SELECT n.* FROM ast_nodes n
        WHERE n.repo_id = $1 AND n.qualified_name IN (SELECT qn FROM neighbor_qnames)
    )
    SELECT json_build_object(
        'sha', $2::text,
        'nodes', COALESCE((
            SELECT json_agg(jsonb_strip_nulls(jsonb_build_object(
                'kind', n.kind, 'name', n.name, 'qualified_name', n.qualified_name,
                'file_path', n.file_path, 'line_start', COALESCE(n.line_start, 0),
                'line_end', COALESCE(n.line_end, 0), 'language', COALESCE(n.language, ''),
                'is_test', n.is_test, 'parent_name', n.parent_name, 'params', n.params,
                'return_type', n.return_type, 'modifiers', n.modifiers
            ))) FROM all_relevant_nodes n
        ), '[]'::json),
        'edges', COALESCE((
            SELECT json_agg(jsonb_strip_nulls(jsonb_build_object(
                'kind', e.kind, 'source_qualified', e.source_qualified,
                'target_qualified', e.target_qualified, 'file_path', e.file_path,
                'line', COALESCE(e.line, 0), 'confidence', e.confidence
            ))) FROM all_edges e
        ), '[]'::json)
    )::text AS graph_json`;

type Graph = { sha: string; nodes: unknown[]; edges: unknown[] };

/** json_agg order is unspecified: compare the sets. */
function normalized(json: string): { nodes: string[]; edges: string[] } {
    const graph = JSON.parse(json) as Graph;
    const key = (value: unknown) =>
        JSON.stringify(value, Object.keys(value as object).sort());
    return {
        nodes: graph.nodes.map(key).sort(),
        edges: graph.edges.map(key).sort(),
    };
}

(skipIntegration ? describe.skip : describe)(
    'AstGraphRepository.exportSubgraphJsonString (integration, real Postgres)',
    () => {
        let canRun = true;
        const executed: string[] = [];
        let repository: AstGraphRepository;

        const repoId = randomUUID();
        const otherRepoId = randomUUID();

        beforeAll(async () => {
            try {
                await dataSource.initialize();
            } catch (error) {
                const code = (error as { code?: string })?.code ?? '';
                if (UNREACHABLE.has(code) && !runningInCi) {
                    canRun = false;
                    console.warn(
                        `[integration] Postgres unreachable (${code}): the subgraph query was NOT exercised.`,
                    );
                    return;
                }
                throw error;
            }

            // Record the SQL the repository sends, to EXPLAIN it below.
            const recording = {
                query: (sql: string, params?: unknown[]) => {
                    executed.push(sql);
                    return dataSource.query(sql, params);
                },
            };
            repository = new AstGraphRepository(
                {} as any,
                {} as any,
                recording as unknown as DataSource,
            );

            await dataSource.query(`CREATE SCHEMA ${schema}`);
            await dataSource.query(`
                CREATE TABLE ast_nodes (
                    id BIGSERIAL PRIMARY KEY,
                    repo_id uuid NOT NULL,
                    kind text NOT NULL,
                    name text NOT NULL,
                    qualified_name text NOT NULL,
                    file_path text NOT NULL,
                    line_start integer, line_end integer, language text,
                    parent_name text, params text, return_type text,
                    modifiers text, is_test boolean NOT NULL DEFAULT false,
                    file_hash text,
                    CONSTRAINT uq_it_nodes UNIQUE (repo_id, qualified_name)
                );
                CREATE INDEX idx_ast_nodes_repo_qual ON ast_nodes (repo_id, qualified_name);
                CREATE INDEX idx_ast_nodes_repo_kind ON ast_nodes (repo_id, kind);
                CREATE INDEX idx_ast_nodes_repo_file ON ast_nodes (repo_id, file_path);
                CREATE TABLE ast_edges (
                    id BIGSERIAL PRIMARY KEY,
                    repo_id uuid NOT NULL,
                    kind text NOT NULL,
                    source_qualified text NOT NULL,
                    target_qualified text NOT NULL,
                    file_path text NOT NULL,
                    line integer NOT NULL DEFAULT 0,
                    confidence real,
                    CONSTRAINT uq_it_edges UNIQUE (repo_id, kind, source_qualified, target_qualified)
                );
                CREATE INDEX idx_ast_edges_repo_file ON ast_edges (repo_id, file_path);
                CREATE INDEX idx_ast_edges_repo_kind ON ast_edges (repo_id, kind);
                CREATE INDEX idx_ast_edges_repo_target ON ast_edges (repo_id, target_qualified);
                CREATE INDEX idx_ast_edges_repo_source ON ast_edges (repo_id, source_qualified);
            `);

            // A hand-built graph with every case the query handles...
            const nodes: [string, string, string][] = [
                // [qualified_name, kind, file_path]
                ['a.ts::A', 'class', 'a.ts'],
                ['a.ts::A.run', 'method', 'a.ts'],
                ['a.ts::helper', 'function', 'a.ts'],
                ['b.ts::B', 'class', 'b.ts'],
                ['b.ts::B.go', 'method', 'b.ts'],
                ['base.ts::Base', 'class', 'base.ts'],
                ['c.ts::C', 'class', 'c.ts'],
                ['c.ts::C.walk', 'method', 'c.ts'],
                ['d.ts::caller', 'function', 'd.ts'],
                ['e.ts::far', 'function', 'e.ts'],
                ['f.ts::F', 'class', 'f.ts'],
            ];
            const edges: [string, string, string, number | null][] = [
                // [kind, source, target, confidence]
                ['CONTAINS', 'a.ts::A', 'a.ts::A.run', null],
                ['INHERITS', 'a.ts::A', 'base.ts::Base', 0.9],
                ['INHERITS', 'c.ts::C', 'base.ts::Base', null],
                ['CONTAINS', 'c.ts::C', 'c.ts::C.walk', null],
                ['CALLS', 'a.ts::A.run', 'a.ts::helper', 1], // both ends in a.ts
                ['CALLS', 'd.ts::caller', 'a.ts::helper', null],
                ['CALLS', 'b.ts::B.go', 'd.ts::caller', null],
                ['CALLS', 'e.ts::far', 'd.ts::caller', null],
                ['IMPORTS', 'b.ts::B', 'e.ts::far', 0],
                // Sibling class C seen from both sides of sibling_edges: an
                // in-kind edge that targets it (target arm) and out-of-kind
                // edges from and to it, which the kind filter must drop.
                ['INHERITS', 'f.ts::F', 'c.ts::C', null],
                ['CALLS', 'c.ts::C', 'e.ts::far', null],
                ['IMPORTS', 'e.ts::far', 'c.ts::C', null],
            ];
            for (const repo of [repoId, otherRepoId]) {
                for (const [qn, kind, file] of nodes) {
                    await dataSource.query(
                        `INSERT INTO ast_nodes (repo_id, kind, name, qualified_name, file_path, line_start, line_end, language)
                         VALUES ($1, $2, $3, $4, $5, 1, 9, 'typescript')`,
                        [repo, kind, qn.split('::')[1], qn, file],
                    );
                }
                for (const [kind, source, target, confidence] of edges) {
                    await dataSource.query(
                        `INSERT INTO ast_edges (repo_id, kind, source_qualified, target_qualified, file_path, line, confidence)
                         VALUES ($1, $2, $3, $4, $5, 3, $6)`,
                        [
                            repo,
                            kind,
                            source,
                            target,
                            source.split('::')[0],
                            confidence,
                        ],
                    );
                }
            }
            // ...inside a repo large enough for the planner to prefer an
            // index (a small table is scanned whatever the query says).
            await dataSource.query(
                `INSERT INTO ast_edges (repo_id, kind, source_qualified, target_qualified, file_path)
                 SELECT $1, 'CALLS', 'gen/f' || i || '.ts::s', 'gen/f' || (i + 1) || '.ts::t', 'gen/f' || i || '.ts'
                 FROM generate_series(1, 50000) i`,
                [repoId],
            );
            await dataSource.query(`ANALYZE ast_nodes; ANALYZE ast_edges;`);
        });

        afterAll(async () => {
            if (dataSource.isInitialized) {
                await dataSource.query(
                    `DROP SCHEMA IF EXISTS ${schema} CASCADE`,
                );
                await dataSource.destroy();
            }
        });

        it.each([
            ['a class with a parent: its siblings come along', ['a.ts']],
            ['a caller in the middle of a call chain', ['d.ts']],
            ['a file with only outgoing edges', ['b.ts']],
            ['several files at once', ['a.ts', 'b.ts', 'e.ts']],
            ['a file with no nodes', ['missing.ts']],
        ])(
            'returns the same nodes and edges as the previous query: %s',
            async (_label, changedFiles) => {
                if (!canRun) return;

                const current = await repository.exportSubgraphJsonString(
                    repoId,
                    changedFiles,
                    'sha-1',
                );
                const [previous] = await dataSource.query(
                    PREVIOUS_SUBGRAPH_SQL,
                    [repoId, 'sha-1', changedFiles],
                );

                expect(JSON.parse(current).sha).toBe('sha-1');
                expect(normalized(current)).toEqual(
                    normalized(previous.graph_json),
                );
            },
        );

        it('finds the parent and the sibling class of a changed class', async () => {
            if (!canRun) return;
            const graph = JSON.parse(
                await repository.exportSubgraphJsonString(repoId, ['a.ts']),
            ) as { nodes: { qualified_name: string }[] };
            const names = graph.nodes.map((n) => n.qualified_name);
            expect(names).toEqual(
                expect.arrayContaining([
                    'base.ts::Base',
                    'c.ts::C',
                    'c.ts::C.walk',
                    'd.ts::caller',
                    // Only through the target arm of sibling_edges.
                    'f.ts::F',
                ]),
            );
            // Only through out-of-kind edges of the sibling: filtered out.
            expect(names).not.toContain('e.ts::far');
        });

        it('leaves no OR of hashed subplans in the plan', async () => {
            if (!canRun) return;
            executed.length = 0;
            await repository.exportSubgraphJsonString(repoId, ['a.ts']);
            const sql = executed.at(-1) as string;

            const explain = async (query: string) =>
                (
                    await dataSource.query(`EXPLAIN ${query}`, [
                        repoId,
                        '',
                        ['a.ts'],
                    ])
                )
                    .map((row: Record<string, string>) => row['QUERY PLAN'])
                    .join('\n');

            // The guard must recognise the old shape, or it proves nothing.
            expect(hasOrOfSubplans(await explain(PREVIOUS_SUBGRAPH_SQL))).toBe(
                true,
            );

            const plan = await explain(sql);
            expect(hasOrOfSubplans(plan)).toBe(false);
            expect(plan).toMatch(/idx_ast_edges_repo_source/);
            expect(plan).toMatch(/idx_ast_edges_repo_target/);
        });
    },
);
