import {
    AstGraphRepository,
    GraphNodeJson,
    GraphEdgeJson,
} from './astGraph.repository';

/**
 * Mutation-killing unit tests for the deterministic logic in
 * AstGraphRepository:
 *   - buildNodeInsertSQL  (private)
 *   - buildEdgeInsertSQL  (private)
 *   - exportAsGraphJson
 *   - exportAsGraphJsonString
 *   - exportSubgraphJsonString
 *
 * The repository is constructed with inert stub deps; only `dataSource.query`
 * is exercised for the export paths. The SQL builders are pure and reached via
 * `(repo as any).methodName(...)`.
 */

const FALLBACK = '{"sha":"","nodes":[],"edges":[]}';

function makeRepo(query?: jest.Mock): AstGraphRepository {
    const dataSource = { query: query ?? jest.fn() } as any;
    return new AstGraphRepository({} as any, {} as any, dataSource);
}

describe('AstGraphRepository — buildNodeInsertSQL', () => {
    const repo = makeRepo();
    const build = (
        repoId: string,
        nodes: GraphNodeJson[],
        onConflict: boolean,
    ) => (repo as any).buildNodeInsertSQL(repoId, nodes, onConflict);

    it('pushes all 14 params in the exact column order for a fully populated node', () => {
        const node: GraphNodeJson = {
            kind: 'function',
            name: 'foo',
            qualified_name: 'mod.foo',
            file_path: 'src/a.ts',
            line_start: 10,
            line_end: 20,
            language: 'typescript',
            is_test: true,
            file_hash: 'abc123',
            parent_name: 'Klass',
            params: 'x: number',
            return_type: 'void',
            modifiers: 'public',
        };

        const { params } = build('REPO', [node], true);

        // Order MUST match the INSERT column list:
        // repo_id, kind, name, qualified_name, file_path, line_start,
        // line_end, language, parent_name, params, return_type, modifiers,
        // is_test, file_hash
        expect(params).toEqual([
            'REPO',
            'function',
            'foo',
            'mod.foo',
            'src/a.ts',
            10,
            20,
            'typescript',
            'Klass',
            'x: number',
            'void',
            'public',
            true,
            'abc123',
        ]);
    });

    it('applies the correct per-field defaults for a minimal node', () => {
        // Only the required fields present; everything optional omitted.
        const node = {
            kind: 'k',
            name: 'n',
            qualified_name: 'q',
            file_path: 'f',
        } as GraphNodeJson;

        const { params } = build('REPO', [node], true);

        // is_test defaults to `false` (NOT null); every other optional to null.
        expect(params).toEqual([
            'REPO',
            'k',
            'n',
            'q',
            'f',
            null, // line_start ?? null
            null, // line_end ?? null
            null, // language ?? null
            null, // parent_name ?? null
            null, // params ?? null
            null, // return_type ?? null
            null, // modifiers ?? null
            false, // is_test ?? false
            null, // file_hash ?? null
        ]);
    });

    it('treats line_start 0 as 0, not the null default (?? boundary)', () => {
        const node = {
            kind: 'k',
            name: 'n',
            qualified_name: 'q',
            file_path: 'f',
            line_start: 0,
            line_end: 0,
        } as GraphNodeJson;

        const { params } = build('REPO', [node], true);

        expect(params[5]).toBe(0); // line_start
        expect(params[6]).toBe(0); // line_end
    });

    it('keeps is_test false as false (not overwritten by the false default)', () => {
        const node = {
            kind: 'k',
            name: 'n',
            qualified_name: 'q',
            file_path: 'f',
            is_test: false,
        } as GraphNodeJson;

        const { params } = build('REPO', [node], true);
        expect(params[12]).toBe(false);
    });

    it('generates contiguous $N placeholders across multiple rows', () => {
        const node = {
            kind: 'k',
            name: 'n',
            qualified_name: 'q',
            file_path: 'f',
        } as GraphNodeJson;

        const { sql, params } = build('REPO', [node, node], true);

        // 2 rows * 14 cols = 28 params.
        expect(params).toHaveLength(28);
        expect(sql).toContain(
            '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        );
        expect(sql).toContain(
            '($15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)',
        );
    });

    it('emits the exact INSERT column list', () => {
        const node = {
            kind: 'k',
            name: 'n',
            qualified_name: 'q',
            file_path: 'f',
        } as GraphNodeJson;

        const { sql } = build('REPO', [node], true);
        expect(sql).toContain('INSERT INTO ast_nodes');
        expect(sql).toContain('repo_id, kind, name, qualified_name, file_path');
        expect(sql).toContain(
            'params, return_type, modifiers, is_test, file_hash',
        );
    });

    it('appends the ON CONFLICT clause only when onConflictIgnore is true', () => {
        const node = {
            kind: 'k',
            name: 'n',
            qualified_name: 'q',
            file_path: 'f',
        } as GraphNodeJson;

        const withConflict = build('REPO', [node], true).sql;
        const withoutConflict = build('REPO', [node], false).sql;

        expect(withConflict).toContain(
            'ON CONFLICT (repo_id, qualified_name) DO NOTHING',
        );
        expect(withoutConflict).not.toContain('ON CONFLICT');
    });
});

describe('AstGraphRepository — buildEdgeInsertSQL', () => {
    const repo = makeRepo();
    const build = (
        repoId: string,
        edges: GraphEdgeJson[],
        onConflict: boolean,
    ) => (repo as any).buildEdgeInsertSQL(repoId, edges, onConflict);

    it('pushes all 7 params in the exact column order for a fully populated edge', () => {
        const edge: GraphEdgeJson = {
            kind: 'CALLS',
            source_qualified: 'a.foo',
            target_qualified: 'b.bar',
            file_path: 'src/a.ts',
            line: 42,
            confidence: 0.9,
        };

        const { params } = build('REPO', [edge], true);

        // Order: repo_id, kind, source_qualified, target_qualified,
        // file_path, line, confidence
        expect(params).toEqual([
            'REPO',
            'CALLS',
            'a.foo',
            'b.bar',
            'src/a.ts',
            42,
            0.9,
        ]);
    });

    it('defaults line to 0 and confidence to null when absent', () => {
        const edge = {
            kind: 'CALLS',
            source_qualified: 'a.foo',
            target_qualified: 'b.bar',
            file_path: 'src/a.ts',
        } as GraphEdgeJson;

        const { params } = build('REPO', [edge], true);

        expect(params).toEqual([
            'REPO',
            'CALLS',
            'a.foo',
            'b.bar',
            'src/a.ts',
            0, // line ?? 0
            null, // confidence ?? null
        ]);
    });

    it('keeps confidence 0 as 0 (?? boundary, not treated as absent)', () => {
        const edge = {
            kind: 'CALLS',
            source_qualified: 'a.foo',
            target_qualified: 'b.bar',
            file_path: 'src/a.ts',
            line: 5,
            confidence: 0,
        } as GraphEdgeJson;

        const { params } = build('REPO', [edge], true);
        expect(params[5]).toBe(5); // line
        expect(params[6]).toBe(0); // confidence stays 0
    });

    it('generates contiguous $N placeholders across multiple rows', () => {
        const edge = {
            kind: 'CALLS',
            source_qualified: 'a',
            target_qualified: 'b',
            file_path: 'f',
        } as GraphEdgeJson;

        const { sql, params } = build('REPO', [edge, edge], true);

        // 2 rows * 7 cols = 14 params.
        expect(params).toHaveLength(14);
        expect(sql).toContain('($1,$2,$3,$4,$5,$6,$7)');
        expect(sql).toContain('($8,$9,$10,$11,$12,$13,$14)');
    });

    it('emits the exact INSERT column list', () => {
        const edge = {
            kind: 'CALLS',
            source_qualified: 'a',
            target_qualified: 'b',
            file_path: 'f',
        } as GraphEdgeJson;

        const { sql } = build('REPO', [edge], true);
        expect(sql).toContain('INSERT INTO ast_edges');
        expect(sql).toContain(
            'repo_id, kind, source_qualified, target_qualified, file_path, line, confidence',
        );
    });

    it('appends the ON CONFLICT clause only when onConflictIgnore is true', () => {
        const edge = {
            kind: 'CALLS',
            source_qualified: 'a',
            target_qualified: 'b',
            file_path: 'f',
        } as GraphEdgeJson;

        const withConflict = build('REPO', [edge], true).sql;
        const withoutConflict = build('REPO', [edge], false).sql;

        expect(withConflict).toContain(
            'ON CONFLICT (repo_id, kind, source_qualified, target_qualified) DO NOTHING',
        );
        expect(withoutConflict).not.toContain('ON CONFLICT');
    });
});

describe('AstGraphRepository — exportAsGraphJson', () => {
    function queryFor(rawNodes: any[], rawEdges: any[]): jest.Mock {
        return jest.fn((sql: string) => {
            if (sql.includes('FROM ast_nodes')) {
                return Promise.resolve(rawNodes);
            }
            if (sql.includes('FROM ast_edges')) {
                return Promise.resolve(rawEdges);
            }
            return Promise.resolve([]);
        });
    }

    it('maps rows to GraphNodeJson/GraphEdgeJson and defaults sha to empty string', async () => {
        const query = queryFor(
            [
                {
                    kind: 'function',
                    name: 'foo',
                    qualified_name: 'mod.foo',
                    file_path: 'src/a.ts',
                    line_start: 10,
                    line_end: 20,
                    language: 'typescript',
                    is_test: false,
                    parent_name: 'Klass',
                    params: 'x',
                    return_type: 'void',
                    modifiers: 'public',
                },
            ],
            [
                {
                    kind: 'CALLS',
                    source_qualified: 'a.foo',
                    target_qualified: 'b.bar',
                    file_path: 'src/a.ts',
                    line: 42,
                    confidence: 0.75,
                },
            ],
        );
        const repo = makeRepo(query);

        const result = await repo.exportAsGraphJson('REPO');

        expect(result).toEqual({
            sha: '',
            nodes: [
                {
                    kind: 'function',
                    name: 'foo',
                    qualified_name: 'mod.foo',
                    file_path: 'src/a.ts',
                    line_start: 10,
                    line_end: 20,
                    language: 'typescript',
                    is_test: false,
                    parent_name: 'Klass',
                    params: 'x',
                    return_type: 'void',
                    modifiers: 'public',
                },
            ],
            edges: [
                {
                    kind: 'CALLS',
                    source_qualified: 'a.foo',
                    target_qualified: 'b.bar',
                    file_path: 'src/a.ts',
                    line: 42,
                    confidence: 0.75,
                },
            ],
        });
    });

    it('returns the provided sha when one is given', async () => {
        const repo = makeRepo(queryFor([], []));
        const result = await repo.exportAsGraphJson('REPO', 'deadbeef');
        expect(result.sha).toBe('deadbeef');
    });

    it('omits falsy optional node fields (parent_name/params/return_type/modifiers)', async () => {
        const query = queryFor(
            [
                {
                    kind: 'function',
                    name: 'foo',
                    qualified_name: 'mod.foo',
                    file_path: 'src/a.ts',
                    line_start: 1,
                    line_end: 2,
                    language: 'ts',
                    is_test: false,
                    parent_name: null,
                    params: '',
                    return_type: undefined,
                    modifiers: null,
                },
            ],
            [],
        );
        const repo = makeRepo(query);

        const result = await repo.exportAsGraphJson('REPO');

        // Exact shape: none of the optional keys should be present.
        expect(result.nodes[0]).toEqual({
            kind: 'function',
            name: 'foo',
            qualified_name: 'mod.foo',
            file_path: 'src/a.ts',
            line_start: 1,
            line_end: 2,
            language: 'ts',
            is_test: false,
        });
        expect('parent_name' in result.nodes[0]).toBe(false);
        expect('params' in result.nodes[0]).toBe(false);
        expect('return_type' in result.nodes[0]).toBe(false);
        expect('modifiers' in result.nodes[0]).toBe(false);
    });

    it('includes confidence 0 but omits null/undefined confidence (!= null guard)', async () => {
        const baseEdge = {
            kind: 'CALLS',
            source_qualified: 'a',
            target_qualified: 'b',
            file_path: 'f',
            line: 1,
        };
        const query = queryFor(
            [],
            [
                { ...baseEdge, confidence: 0 },
                { ...baseEdge, confidence: null },
                { ...baseEdge, confidence: undefined },
            ],
        );
        const repo = makeRepo(query);

        const result = await repo.exportAsGraphJson('REPO');

        // confidence 0 is kept (0 != null is true).
        expect(result.edges[0]).toEqual({
            kind: 'CALLS',
            source_qualified: 'a',
            target_qualified: 'b',
            file_path: 'f',
            line: 1,
            confidence: 0,
        });
        // null and undefined confidence are omitted.
        expect('confidence' in result.edges[1]).toBe(false);
        expect('confidence' in result.edges[2]).toBe(false);
    });
});

describe('AstGraphRepository — exportAsGraphJsonString', () => {
    it('returns the graph_json string from the query result', async () => {
        const query = jest
            .fn()
            .mockResolvedValue([
                { graph_json: '{"sha":"x","nodes":[],"edges":[]}' },
            ]);
        const repo = makeRepo(query);

        const out = await repo.exportAsGraphJsonString('REPO', 'x');
        expect(out).toBe('{"sha":"x","nodes":[],"edges":[]}');
    });

    it('passes repoId and the sha (empty-string default) as query params', async () => {
        const query = jest.fn().mockResolvedValue([{ graph_json: '{}' }]);
        const repo = makeRepo(query);

        await repo.exportAsGraphJsonString('REPO');

        expect(query).toHaveBeenCalledTimes(1);
        // second arg is the params array: [repoId, sha || '']
        expect(query.mock.calls[0][1]).toEqual(['REPO', '']);
    });

    it('forwards the provided sha as the second param', async () => {
        const query = jest.fn().mockResolvedValue([{ graph_json: '{}' }]);
        const repo = makeRepo(query);

        await repo.exportAsGraphJsonString('REPO', 'abc');
        expect(query.mock.calls[0][1]).toEqual(['REPO', 'abc']);
    });

    it('falls back to the empty-graph literal when the result row is missing', async () => {
        const repo = makeRepo(jest.fn().mockResolvedValue([]));
        const out = await repo.exportAsGraphJsonString('REPO');
        expect(out).toBe(FALLBACK);
    });

    it('falls back to the empty-graph literal when graph_json is null', async () => {
        const repo = makeRepo(
            jest.fn().mockResolvedValue([{ graph_json: null }]),
        );
        const out = await repo.exportAsGraphJsonString('REPO');
        expect(out).toBe(FALLBACK);
    });
});

describe('AstGraphRepository — exportSubgraphJsonString', () => {
    it('short-circuits to the empty-graph literal without querying when changedFiles is empty', async () => {
        const query = jest.fn();
        const repo = makeRepo(query);

        const out = await repo.exportSubgraphJsonString('REPO', []);

        expect(out).toBe(FALLBACK);
        expect(query).not.toHaveBeenCalled();
    });

    it('returns the graph_json string and passes [repoId, sha, changedFiles] params', async () => {
        const query = jest
            .fn()
            .mockResolvedValue([{ graph_json: '{"nodes":[1]}' }]);
        const repo = makeRepo(query);

        const out = await repo.exportSubgraphJsonString(
            'REPO',
            ['src/a.ts', 'src/b.ts'],
            'sha1',
        );

        expect(out).toBe('{"nodes":[1]}');
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][1]).toEqual([
            'REPO',
            'sha1',
            ['src/a.ts', 'src/b.ts'],
        ]);
    });

    it('defaults sha to empty string in the params when omitted', async () => {
        const query = jest.fn().mockResolvedValue([{ graph_json: '{}' }]);
        const repo = makeRepo(query);

        await repo.exportSubgraphJsonString('REPO', ['src/a.ts']);
        expect(query.mock.calls[0][1]).toEqual(['REPO', '', ['src/a.ts']]);
    });

    it('falls back to the empty-graph literal when the result row is missing', async () => {
        const repo = makeRepo(jest.fn().mockResolvedValue([]));
        const out = await repo.exportSubgraphJsonString('REPO', ['src/a.ts']);
        expect(out).toBe(FALLBACK);
    });

    it('falls back to the empty-graph literal when graph_json is null', async () => {
        const repo = makeRepo(
            jest.fn().mockResolvedValue([{ graph_json: null }]),
        );
        const out = await repo.exportSubgraphJsonString('REPO', ['src/a.ts']);
        expect(out).toBe(FALLBACK);
    });
});
