import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createLogger } from '@libs/core/log/logger';

import { AstNodeModel } from './schemas/astNode.model';
import { AstEdgeModel } from './schemas/astEdge.model';

// ---------------------------------------------------------------------------
// JSON interfaces matching kodus-graph's GraphInputSchema (snake_case)
// ---------------------------------------------------------------------------

export interface GraphNodeJson {
    kind: string;
    name: string;
    qualified_name: string;
    file_path: string;
    line_start: number;
    line_end: number;
    language: string;
    is_test: boolean;
    file_hash?: string; // optional - only present in parse output, not in export
    parent_name?: string;
    params?: string;
    return_type?: string;
    modifiers?: string;
}

export interface GraphEdgeJson {
    kind: string;
    source_qualified: string;
    target_qualified: string;
    file_path: string;
    line: number;
    confidence?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_COL_COUNT = 14;
const EDGE_COL_COUNT = 7;

/** PG limit = 65 535 params. Compute max rows per INSERT dynamically. */
const NODE_CHUNK_SIZE = Math.floor(65535 / NODE_COL_COUNT); // ~4681
const EDGE_CHUNK_SIZE = Math.floor(65535 / EDGE_COL_COUNT); // ~9362

// ---------------------------------------------------------------------------
// Repository — raw SQL for all write/read paths
// ---------------------------------------------------------------------------

@Injectable()
export class AstGraphRepository {
    private readonly logger = createLogger(AstGraphRepository.name);

    constructor(
        // Kept for TypeORM module registration (forFeature).
        @InjectRepository(AstNodeModel)
        private readonly _nodeRepo: Repository<AstNodeModel>,
        @InjectRepository(AstEdgeModel)
        private readonly _edgeRepo: Repository<AstEdgeModel>,
        private readonly dataSource: DataSource,
    ) { }

    // -----------------------------------------------------------------------
    // Delete helpers
    // -----------------------------------------------------------------------

    async deleteAll(repoId: string): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            await manager.query(
                `DELETE FROM ast_edges WHERE repo_id = $1`,
                [repoId],
            );
            await manager.query(
                `DELETE FROM ast_nodes WHERE repo_id = $1`,
                [repoId],
            );
        });
    }

    async deleteByFiles(repoId: string, filePaths: string[]): Promise<void> {
        if (filePaths.length === 0) return;

        await this.dataSource.transaction(async (manager) => {
            await manager.query(
                `DELETE FROM ast_edges WHERE repo_id = $1 AND file_path = ANY($2::text[])`,
                [repoId, filePaths],
            );
            await manager.query(
                `DELETE FROM ast_nodes WHERE repo_id = $1 AND file_path = ANY($2::text[])`,
                [repoId, filePaths],
            );
        });
    }

    // -----------------------------------------------------------------------
    // Bulk insert helpers
    // -----------------------------------------------------------------------

    async bulkInsertNodes(
        repoId: string,
        nodes: GraphNodeJson[],
    ): Promise<number> {
        if (nodes.length === 0) return 0;
        let count = 0;
        for (let i = 0; i < nodes.length; i += NODE_CHUNK_SIZE) {
            const chunk = nodes.slice(i, i + NODE_CHUNK_SIZE);
            const { sql, params } = this.buildNodeInsertSQL(
                repoId,
                chunk,
                true,
            );
            await this.dataSource.query(sql, params);
            count += chunk.length;
        }
        return count;
    }

    async bulkInsertEdges(
        repoId: string,
        edges: GraphEdgeJson[],
    ): Promise<number> {
        if (edges.length === 0) return 0;
        let count = 0;
        for (let i = 0; i < edges.length; i += EDGE_CHUNK_SIZE) {
            const chunk = edges.slice(i, i + EDGE_CHUNK_SIZE);
            const { sql, params } = this.buildEdgeInsertSQL(
                repoId,
                chunk,
                true,
            );
            await this.dataSource.query(sql, params);
            count += chunk.length;
        }
        return count;
    }

    // -----------------------------------------------------------------------
    // Transactional operations
    // -----------------------------------------------------------------------

    /**
     * Full rebuild: delete all existing data and insert everything in a single
     * transaction.  Uses ON CONFLICT DO NOTHING to handle duplicate
     * qualified_name entries that can appear in minified/bundled files.
     */
    async fullRebuild(
        repoId: string,
        nodes: GraphNodeJson[],
        edges: GraphEdgeJson[],
    ): Promise<{ nodeCount: number; edgeCount: number }> {
        return this.dataSource.transaction(async (manager) => {
            await manager.query(`DELETE FROM ast_edges WHERE repo_id = $1`, [
                repoId,
            ]);
            await manager.query(`DELETE FROM ast_nodes WHERE repo_id = $1`, [
                repoId,
            ]);

            for (let i = 0; i < nodes.length; i += NODE_CHUNK_SIZE) {
                const chunk = nodes.slice(i, i + NODE_CHUNK_SIZE);
                const { sql, params } = this.buildNodeInsertSQL(
                    repoId,
                    chunk,
                    true,
                );
                await manager.query(sql, params);
            }

            for (let i = 0; i < edges.length; i += EDGE_CHUNK_SIZE) {
                const chunk = edges.slice(i, i + EDGE_CHUNK_SIZE);
                const { sql, params } = this.buildEdgeInsertSQL(
                    repoId,
                    chunk,
                    true,
                );
                await manager.query(sql, params);
            }

            // Query actual counts — ON CONFLICT DO NOTHING may skip duplicates
            const [nodeRows] = await manager.query(
                `SELECT count(*)::int AS cnt FROM ast_nodes WHERE repo_id = $1`,
                [repoId],
            );
            const [edgeRows] = await manager.query(
                `SELECT count(*)::int AS cnt FROM ast_edges WHERE repo_id = $1`,
                [repoId],
            );

            return {
                nodeCount: nodeRows.cnt,
                edgeCount: edgeRows.cnt,
            };
        });
    }

    /**
     * Incremental update: delete stale data for changed files, then insert
     * fresh data — all in a single transaction.
     * Uses ON CONFLICT DO NOTHING because edges from non-updated files may
     * share qualified names with the new data.
     */
    async incrementalUpdate(
        repoId: string,
        filePaths: string[],
        nodes: GraphNodeJson[],
        edges: GraphEdgeJson[],
    ): Promise<{ nodeCount: number; edgeCount: number }> {
        return this.dataSource.transaction(async (manager) => {
            if (filePaths.length > 0) {
                await manager.query(
                    `DELETE FROM ast_edges WHERE repo_id = $1 AND file_path = ANY($2::text[])`,
                    [repoId, filePaths],
                );
                await manager.query(
                    `DELETE FROM ast_nodes WHERE repo_id = $1 AND file_path = ANY($2::text[])`,
                    [repoId, filePaths],
                );
            }

            for (let i = 0; i < nodes.length; i += NODE_CHUNK_SIZE) {
                const chunk = nodes.slice(i, i + NODE_CHUNK_SIZE);
                const { sql, params } = this.buildNodeInsertSQL(
                    repoId,
                    chunk,
                    true,
                );
                await manager.query(sql, params);
            }

            for (let i = 0; i < edges.length; i += EDGE_CHUNK_SIZE) {
                const chunk = edges.slice(i, i + EDGE_CHUNK_SIZE);
                const { sql, params } = this.buildEdgeInsertSQL(
                    repoId,
                    chunk,
                    true,
                );
                await manager.query(sql, params);
            }

            // Query actual total counts for the repo after the incremental update
            const [nodeRows] = await manager.query(
                `SELECT count(*)::int AS cnt FROM ast_nodes WHERE repo_id = $1`,
                [repoId],
            );
            const [edgeRows] = await manager.query(
                `SELECT count(*)::int AS cnt FROM ast_edges WHERE repo_id = $1`,
                [repoId],
            );

            return {
                nodeCount: nodeRows.cnt,
                edgeCount: edgeRows.cnt,
            };
        });
    }

    // -----------------------------------------------------------------------
    // Export
    // -----------------------------------------------------------------------

    /**
     * Export the full graph as JS objects.
     * Raw SQL avoids ORM entity hydration (no intermediate AstNodeModel instances).
     */
    async exportAsGraphJson(
        repoId: string,
        sha?: string,
    ): Promise<{
        sha: string;
        nodes: GraphNodeJson[];
        edges: GraphEdgeJson[];
    }> {
        const [rawNodes, rawEdges] = await Promise.all([
            this.dataSource.query(
                `SELECT kind, name, qualified_name, file_path,
                        COALESCE(line_start, 0) AS line_start,
                        COALESCE(line_end, 0) AS line_end,
                        COALESCE(language, '') AS language,
                        is_test,
                        parent_name, params, return_type, modifiers
                 FROM ast_nodes WHERE repo_id = $1`,
                [repoId],
            ),
            this.dataSource.query(
                `SELECT kind, source_qualified, target_qualified,
                        file_path, COALESCE(line, 0) AS line, confidence
                 FROM ast_edges WHERE repo_id = $1`,
                [repoId],
            ),
        ]);

        const nodes: GraphNodeJson[] = rawNodes.map((n: any) => ({
            kind: n.kind,
            name: n.name,
            qualified_name: n.qualified_name,
            file_path: n.file_path,
            line_start: n.line_start,
            line_end: n.line_end,
            language: n.language,
            is_test: n.is_test,
            ...(n.parent_name && { parent_name: n.parent_name }),
            ...(n.params && { params: n.params }),
            ...(n.return_type && { return_type: n.return_type }),
            ...(n.modifiers && { modifiers: n.modifiers }),
        }));

        const edges: GraphEdgeJson[] = rawEdges.map((e: any) => ({
            kind: e.kind,
            source_qualified: e.source_qualified,
            target_qualified: e.target_qualified,
            file_path: e.file_path,
            line: e.line,
            ...(e.confidence != null && { confidence: e.confidence }),
        }));

        return { sha: sha || '', nodes, edges };
    }

    /**
     * Export the full graph as a JSON **string** built entirely in PostgreSQL.
     * Zero intermediate JS objects — ideal for writing to the E2B sandbox.
     */
    async exportAsGraphJsonString(
        repoId: string,
        sha?: string,
    ): Promise<string> {
        const result = await this.dataSource.query(
            `SELECT json_build_object(
                'sha', $2::text,
                'nodes', COALESCE((
                    SELECT json_agg(jsonb_strip_nulls(jsonb_build_object(
                        'kind', kind,
                        'name', name,
                        'qualified_name', qualified_name,
                        'file_path', file_path,
                        'line_start', COALESCE(line_start, 0),
                        'line_end', COALESCE(line_end, 0),
                        'language', COALESCE(language, ''),
                        'is_test', is_test,
                        'parent_name', parent_name,
                        'params', params,
                        'return_type', return_type,
                        'modifiers', modifiers
                    ))) FROM ast_nodes WHERE repo_id = $1
                ), '[]'::json),
                'edges', COALESCE((
                    SELECT json_agg(jsonb_strip_nulls(jsonb_build_object(
                        'kind', kind,
                        'source_qualified', source_qualified,
                        'target_qualified', target_qualified,
                        'file_path', file_path,
                        'line', COALESCE(line, 0),
                        'confidence', confidence
                    ))) FROM ast_edges WHERE repo_id = $1
                ), '[]'::json)
            )::text AS graph_json`,
            [repoId, sha || ''],
        );

        return result[0]?.graph_json || '{"sha":"","nodes":[],"edges":[]}';
    }

    /**
     * Export a filtered subgraph as a JSON string built entirely in PostgreSQL.
     * Only includes nodes in changed files + their direct neighbors (callers/callees).
     * ~99% reduction vs full export for typical PRs.
     *
     * Requires index: CREATE INDEX idx_ast_edges_repo_target ON ast_edges (repo_id, target_qualified)
     */
    async exportSubgraphJsonString(
        repoId: string,
        changedFiles: string[],
        sha?: string,
        includeDuplicates = false,
        prNodesJson?: string,
        fileChanges: Array<{ filename?: string; patch?: string }> = [],
    ): Promise<string> {

        if (changedFiles.length === 0) {
            return '{"sha":"","nodes":[],"edges":[]}';
        }

        // Parse sandbox PR graph JSON (nodes & edges for new PR files) BEFORE the
        // query below, which references them in its params (prNodes/prEdges).
        // Normalize the path-like fields ONCE here, at the boundary — the sandbox
        // CLI may emit backslashes, and every consumer (SQL $4/$5, pr_sandbox_*,
        // and the TS matcher) relies on forward slashes.
        let prNodes: any[] = [];
        let prEdges: any[] = [];
        if (prNodesJson) {
            try {
                const parsed = JSON.parse(prNodesJson);
                prNodes = (parsed.nodes || []).map((n: any) => ({
                    ...n,
                    qualified_name: (n?.qualified_name || ''),
                    file_path: (n?.file_path || ''),
                }));
                prEdges = (parsed.edges || []).map((e: any) => ({
                    ...e,
                    source_qualified: (e?.source_qualified || ''),
                    target_qualified: (e?.target_qualified || ''),
                }));
            } catch (e) {
                this.logger.warn({
                    message: '[AST-GRAPH] Failed to parse prNodesJson in exportSubgraphJsonString',
                    context: AstGraphRepository.name,
                    error: e,
                    metadata: { repoId },
                });
            }
        }

        const result = await this.dataSource.query(
            `WITH changed_nodes AS (
                SELECT qualified_name, name, params, return_type,
                       file_path, line_start, line_end
                FROM ast_nodes
                WHERE repo_id = $1 AND file_path = ANY($3::text[])
            ),
            -- Edges touching changed nodes (direct neighbors)
            touching_edges AS (
                SELECT e.*
                FROM ast_edges e
                WHERE e.repo_id = $1
                  AND (
                      e.source_qualified IN (SELECT qualified_name FROM changed_nodes)
                      OR e.target_qualified IN (SELECT qualified_name FROM changed_nodes)
                  )
            ),
            -- Parent classes of changed classes (via INHERITS edges in touching_edges)
            parent_classes AS (
                SELECT DISTINCT e.target_qualified AS qn
                FROM touching_edges e
                WHERE e.kind = 'INHERITS'
            ),
            -- Sibling classes: other classes that inherit from the same parent
            sibling_classes AS (
                SELECT DISTINCT e.source_qualified AS qn
                FROM ast_edges e
                WHERE e.repo_id = $1
                  AND e.kind = 'INHERITS'
                  AND e.target_qualified IN (SELECT qn FROM parent_classes)
            ),
            -- Sibling edges: INHERITS + CONTAINS edges for sibling classes (to get their methods)
            sibling_edges AS (
                SELECT e.*
                FROM ast_edges e
                WHERE e.repo_id = $1
                  AND e.kind IN ('INHERITS', 'CONTAINS')
                  AND (
                      e.source_qualified IN (SELECT qn FROM sibling_classes)
                      OR e.target_qualified IN (SELECT qn FROM sibling_classes)
                  )
            ),
            -- All edges: direct neighbors + sibling relationships
            all_edges AS (
                SELECT * FROM touching_edges
                UNION
                SELECT * FROM sibling_edges
            ),
            neighbor_qnames AS (
                SELECT DISTINCT source_qualified AS qn FROM all_edges
                UNION
                SELECT DISTINCT target_qualified AS qn FROM all_edges
            ),
            all_relevant_nodes AS (
                SELECT n.*
                FROM ast_nodes n
                WHERE n.repo_id = $1
                  AND n.qualified_name IN (SELECT qn FROM neighbor_qnames)
            )
            SELECT json_build_object(
                'sha', $2::text,
                'nodes', COALESCE((
                    SELECT json_agg(jsonb_strip_nulls(jsonb_build_object(
                        'kind', n.kind,
                        'name', n.name,
                        'qualified_name', n.qualified_name,
                        'file_path', n.file_path,
                        'line_start', COALESCE(n.line_start, 0),
                        'line_end', COALESCE(n.line_end, 0),
                        'language', COALESCE(n.language, ''),
                        'is_test', n.is_test,
                        'parent_name', n.parent_name,
                        'params', n.params,
                        'return_type', n.return_type,
                        'modifiers', n.modifiers
                    ))) FROM all_relevant_nodes n
                ), '[]'::json),
                'edges', COALESCE((
                    SELECT json_agg(jsonb_strip_nulls(jsonb_build_object(
                        'kind', e.kind,
                        'source_qualified', e.source_qualified,
                        'target_qualified', e.target_qualified,
                        'file_path', e.file_path,
                        'line', COALESCE(e.line, 0),
                        'confidence', e.confidence
                    ))) FROM all_edges e
                ), '[]'::json)
            )::text AS graph_json`,
            [repoId, sha || '', changedFiles],
        );

        let jsonOutput = result[0]?.graph_json || '{"sha":"","nodes":[],"edges":[]}';
        try {
            const parsed = JSON.parse(jsonOutput);

            // Pair changed functions against twin pool matching params, return type, & shared callees.
            if (includeDuplicates) {
                // Requires diff patches to identify changed functions.
                const hasPatches = (fileChanges || []).some((fc) => !!fc?.patch);
                if (hasPatches) {
                    // Build per-PR-function callee sets from the edges the
                    // main subgraph query already returned
                    const prCalleesBySource = new Map<string, Set<string>>();
                    for (const e of prEdges || []) {
                        if (e?.kind !== 'CALLS') continue;
                        if (!e.source_qualified) continue;
                        if (!prCalleesBySource.has(e.source_qualified)) {
                            prCalleesBySource.set(e.source_qualified, new Set());
                        }
                        prCalleesBySource.get(e.source_qualified)!.add(e.target_qualified);
                    }

                    // Collect the union of all PR-function callees so we can
                    // pre-filter candidates in Postgres (keeps the result set
                    // small before the per-function 80% gate runs in JS).
                    const allPrCallees = [
                        ...new Set(
                            [...prCalleesBySource.values()].flatMap((s) => [...s]),
                        ),
                    ];

                    // Single batch query: fetch every repo function that shares
                    // at least one callee with any PR function.
                    const batchTwinQuery = `
                        SELECT n.qualified_name, n.params, n.return_type,
                               n.file_path, COALESCE(n.line_start, 0) AS line_start,
                               COALESCE(n.line_end, 0) AS line_end,
                               COALESCE(array_agg(DISTINCT e.target_qualified)
                                        FILTER (WHERE e.kind = 'CALLS'
                                                AND e.target_qualified IS NOT NULL),
                                        ARRAY[]::text[]) AS callees
                        FROM ast_nodes n
                        LEFT JOIN ast_edges e
                             ON e.repo_id = n.repo_id
                            AND e.source_qualified = n.qualified_name
                        WHERE n.repo_id = $1
                          AND n.kind IN ('Function', 'Method')
                          AND n.params IS NOT NULL AND n.params <> ''
                        GROUP BY n.qualified_name, n.params, n.return_type,
                                 n.file_path, n.line_start, n.line_end
                        HAVING $2::text[] && COALESCE(
                            array_agg(DISTINCT e.target_qualified)
                            FILTER (WHERE e.kind = 'CALLS'
                                    AND e.target_qualified IS NOT NULL),
                            ARRAY[]::text[]
                        )
                    `;

                    // Helper: what fraction of prCallees does candidate share?
                    const overlapRatio = (
                        candidateCallees: string[],
                        prCallees: Set<string>,
                    ): number => {
                        if (prCallees.size === 0) return 0;
                        const hits = candidateCallees.filter((c) =>
                            prCallees.has(c),
                        ).length;
                        return hits / prCallees.size;
                    };

                    const poolRows: any[] = [];
                    if (allPrCallees.length > 0) {
                        try {
                            const res = await this.dataSource.query(batchTwinQuery, [
                                repoId,
                                allPrCallees,
                            ]);
                            const rows: any[] = res?.rows || [];

                            // Per-function overlap gate (>=80%) applied in JS.
                            const seenQns = new Set<string>();
                            for (const row of rows) {
                                if (seenQns.has(row.qualified_name)) continue;
                                const candidateCallees: string[] = row.callees || [];
                                // Accept if this candidate clears the threshold for
                                // at least one changed PR function, and is not the
                                // PR function itself.
                                const qualifies = [...prCalleesBySource.entries()].some(
                                    ([prQn, prCallees]) =>
                                        row.qualified_name !== prQn &&
                                        overlapRatio(candidateCallees, prCallees) >= 0.8,
                                );
                                if (qualifies) {
                                    seenQns.add(row.qualified_name);
                                    poolRows.push(row);
                                }
                            }
                        } catch (err) {
                            this.logger.warn({
                                message: '[AST-GRAPH] Batch twin pool query failed',
                                context: AstGraphRepository.name,
                                error: err,
                                metadata: { repoId },
                            });
                        }
                    }
                    // Rows -> node objects (shape the matcher reads).
                    const twinPool: any[] = poolRows.map((r) => ({
                        kind: 'Function',
                        qualified_name: r.qualified_name,
                        name: (r.qualified_name || '').split('::').pop(),
                        params: r.params,
                        return_type: r.return_type,
                        file_path: r.file_path,
                        line_start: r.line_start ?? 0,
                        line_end: r.line_end ?? 0,
                    }));
                    // Rows -> CALLS edges (unpack callees) for the overlap gate.
                    const poolEdges: any[] = poolRows.flatMap((r) =>
                        (r.callees || []).map((cal: string) => ({
                            kind: 'CALLS',
                            source_qualified: r.qualified_name,
                            target_qualified: cal,
                        })),
                    );
                    this.pairDuplicateTwinsInGraph(
                        {
                            // byQn = twin pool; sources = prNodes ∩ hunks (4th arg).
                            nodes: twinPool,
                            edges: [...poolEdges, ...(prEdges || [])],
                        },
                        prEdges,
                        prNodes || [],
                        fileChanges,
                    );
                    // Merge flagged (PR + pool) nodes into parsed.nodes for the output.
                    const nodeIndexByQn = new Map<string, number>(
                        (parsed.nodes as any[]).map((n: any, i: number) => [
                            n?.qualified_name,
                            i,
                        ]),
                    );
                    const flaggedNodes = [
                        ...(prNodes || []).filter((n: any) => n?.is_duplicate),
                        ...twinPool.filter((n: any) => n?.is_duplicate),
                    ];
                    for (const f of flaggedNodes) {
                        const idx = nodeIndexByQn.get(f.qualified_name);
                        if (idx !== undefined) parsed.nodes[idx] = f;
                        else {
                            nodeIndexByQn.set(f.qualified_name, parsed.nodes.length);
                            parsed.nodes.push(f);
                        }
                    }
                }
                // Re-serialize so the pair flags survive — jsonOutput is the
                // string the consumers re-parse.
                jsonOutput = JSON.stringify(parsed);
            }

            const duplicateNodes = (parsed.nodes || []).filter((n: any) => n.is_duplicate);
            if (duplicateNodes.length > 0) {
                this.logger.log({
                    message: `Flagged ${duplicateNodes.length} duplicate twin nodes in subgraph`,
                    context: AstGraphRepository.name,
                    metadata: { repoId, count: duplicateNodes.length },
                });
            }

        } catch (e) {
            this.logger.warn({
                message: '[AST-GRAPH] Failed to parse or process subgraph JSON in exportSubgraphJsonString',
                context: AstGraphRepository.name,
                error: e,
                metadata: { repoId },
            });
        }

        return jsonOutput;
    }

    // -----------------------------------------------------------------------
    // Duplicate twin pairing (TypeScript)
    // -----------------------------------------------------------------------

    /**
     * Mark duplicate pairs in-place on `graph.nodes`.
     *
     * Matches changed functions against every function in the graph: same
     * {name|type} param token-set (order-insensitive, lowercased), compatible
     * return types (NULL==NULL allowed), and at least one overlapping repo
     * callee. Sets `is_duplicate` + `duplicate_twin` on both members.
     */
    private pairDuplicateTwinsInGraph(
        graph: { nodes?: any[]; edges?: any[] },
        prEdges: { source_qualified: string; target_qualified: string; kind: string }[] = [],
        prNodes: any[] = [],
        fileChanges: Array<{ filename?: string; patch?: string }> = [],
    ): void {
        const nodes = graph.nodes ?? [];

        if (nodes.length < 2) return;

        // Sources = nodes the PR actually touched. The sandbox parses WHOLE
        // files, so every PR node (changed or not) is in prNodes. The diff's
        // added-line ranges (new-file side) pick out the ones with changed
        // lines. Sources can ONLY come from prNodes — they carry NEW-file line
        // numbers (the coordinate space hunks use). DB-only nodes carry OLD
        // lines and would false-match hunks.
        const addedRangesByFile = new Map<string, Array<[number, number]>>();
        for (const fc of fileChanges || []) {
            const path = fc?.filename;
            if (!path || !fc?.patch) continue;
            const ranges: Array<[number, number]> = [];
            let newStart = 0, newCount = 0, newLine = 0;
            for (const line of fc.patch.split('\n')) {
                const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
                if (hunk) {
                    newStart = parseInt(hunk[1], 10);
                    newCount = hunk[2] ? parseInt(hunk[2], 10) : 1;
                    newLine = newStart;
                    continue;
                }
                if (newLine === 0) continue; // pre-hunk header lines
                if (line.startsWith('+')) {
                    ranges.push([newLine, newLine]);
                    newLine++;
                } else if (line.startsWith('-')) {
                    // deleted line — does not advance the new-file cursor
                } else {
                    newLine++; // context line
                }
            }
            if (ranges.length) addedRangesByFile.set(path, ranges);
        }
        const lineHitsHunk = (filePath: string, lineStart: number, lineEnd: number) => {
            const normPath = (filePath || '');
            const ranges = addedRangesByFile.get(normPath);
            if (!ranges) return false;
            for (const [s, e] of ranges) {
                if (s >= lineStart && s <= lineEnd) return true;
            }
            return false;
        };

        // --- Tokenize params into {name|type} tokens (lowercased) ---
        const tokenize = (raw: unknown): Set<string> => {
            const s = typeof raw === 'string' ? raw : '';
            const tokens = new Set<string>();
            // Signed ({ a, b }: { a: T; b: U }): the trailing {…} holds the types.
            // Multiple destructures ({ a }, { b }): no head (`}:` absent) → keep all.
            const blocks = s.match(/\{[^{}]*\}/g) || [];
            const hasHead = blocks.some((b) => {
                let i = s.indexOf(b) + b.length;
                while (i < s.length && s[i] === ' ') i++;
                return s[i] === ':';
            });
            const ann = hasHead ? blocks[blocks.length - 1] : s;
            // name (optional `?`) : type — charset stops at `,;|=>}` so defaults,
            // unions, arrays, arrows leave the plain leading type.
            const colonMatches = ann.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^,;|=>}]+)/g);
            for (const m of colonMatches) {
                tokens.add(`${m[1].toLowerCase()}|${m[2].trim().toLowerCase()}`);
            }
            // No colons → untyped (a, b): name-only tokens so they still match.
            if (tokens.size === 0) {
                for (const m of ann.matchAll(/([A-Za-z_$][\w$]*)/g)) {
                    tokens.add(`${m[1].toLowerCase()}|`);
                }
            }
            return tokens;
        };

        const byQn = new Map<string, any>();
        for (const n of nodes) {
            if (n?.kind === 'Function' || n?.kind === 'Method') {
                byQn.set(n.qualified_name, n);
            }
        }

        // Skip if no patch data reached us (the hasPatches gate in the caller
        // should prevent this — belt-and-suspenders here).
        if (addedRangesByFile.size === 0) {
            return;
        }
        const changed = (prNodes || []).filter((n: any) => {
            const filePath = n?.file_path as string | undefined;
            if (!filePath) return false;
            // Source = a PR node (new-file lines) whose range intersects an
            // added hunk.
            return lineHitsHunk(filePath, n.line_start ?? 0, n.line_end ?? 0);
        });

        if (changed.length === 0) return;

        // Changed functions are those SQL pre-filtered (changed_functions); that
        // subset now narrows to functions with >=1 repo callee. Build callee sets
        // from the graph edges for the overlap requirement.
        const calleeOf = new Map<string, Set<string>>();
        const seedCallee = (from: string, to: string) => {
            if (!from) return;
            if (!calleeOf.has(from)) calleeOf.set(from, new Set<string>());
            calleeOf.get(from)!.add(to);
        };

        for (const e of graph?.edges || []) {
            if (e?.kind !== 'CALLS') continue;
            if (Boolean(e.source_qualified) && Boolean(e.target_qualified)) {
                seedCallee(e.source_qualified, e.target_qualified);
            }
        }

        // The overlap check needs each function's callee set — who does it call?
        // But the sandbox-side calls (the ones from new files) would be invisible if we only used graph.edges
        for (const e of prEdges || []) {
            if (e?.kind !== 'CALLS') continue;
            if (Boolean(e.source_qualified) && Boolean(e.target_qualified)) {
                seedCallee(e.source_qualified, e.target_qualified);
            }
        }

        // Pairs where the changed function is the "source" (twin is anywhere in repo).
        const seen = new Set<string>();
        const addPair = (a: any, b: any) => {
            if (!a || !b || a === b) return;
            const key = [...[a.qualified_name, b.qualified_name]].sort().join('|');
            if (seen.has(key)) return;
            seen.add(key);
            a.is_duplicate = true;
            b.is_duplicate = true;
            a.duplicate_twin = {
                qualified_name: b.qualified_name,
                file_path: b.file_path,
                line_start: b.line_start ?? 0,
                line_end: b.line_end ?? 0,
            };
            b.duplicate_twin = {
                qualified_name: a.qualified_name,
                file_path: a.file_path,
                line_start: a.line_start ?? 0,
                line_end: a.line_end ?? 0,
            };
        };

        for (const c of changed) {
            // changed function param
            const cTokens = tokenize(c.params);
            const cRet = c.return_type;
            const why: any = { returnType: 0, tokens: 0, noOverlap: 0, lowSimilarity: 0, pairs: 0 };
            if (cTokens.size === 0) continue; // unparseable/missing params — skip

            for (const other of byQn.values()) {
                if (other.qualified_name === c.qualified_name) continue;
                // Return-type compatibility (NULL==NULL allowed)
                if (cRet !== other.return_type &&
                    !(cRet == null && other.return_type == null)) {
                    why.returnType++;
                    continue;
                }
                // twin function param
                const oTokens = tokenize(other.params);
                if (oTokens.size === 0) { why.tokens++; continue; }
                // Similarity: fraction of c's tokens present in o's set.
                // Providers rename params (payid vs csid), so exact equality is
                // too strict — allow >=50% overlap.
                let matched = 0;
                for (const tk of cTokens) {
                    if (oTokens.has(tk)) matched++;
                }
                const similarity = matched / cTokens.size;
                if (similarity < 0.5) { why.lowSimilarity++; continue; }
                // Overlapping repo callees. Require >=2 shared callees for generic similarity (0.50),
                // but allow minOverlap=1 when parameter token similarity is high (>=0.70).
                const cc = calleeOf.get(c.qualified_name) ?? new Set<string>();
                const oc = calleeOf.get(other.qualified_name) ?? new Set<string>();
                let overlap = 0;
                for (const cal of cc) {
                    if (oc.has(cal)) overlap++;
                }
                const minOverlap = similarity >= 0.7 ? 1 : 2;
                if (overlap < minOverlap) { why.noOverlap++; continue; }
                addPair(c, other);
                why.pairs++;
                why.i = similarity;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Private SQL builders
    // -----------------------------------------------------------------------

    /**
     * Parameterized multi-row INSERT for ast_nodes.
     * Every value goes through $N — no string interpolation.
     */
    private buildNodeInsertSQL(
        repoId: string,
        nodes: GraphNodeJson[],
        onConflictIgnore: boolean,
    ): { sql: string; params: any[] } {
        const params: any[] = [];
        const rows: string[] = [];

        for (const n of nodes) {
            const base = params.length;
            params.push(
                repoId,
                n.kind,
                n.name,
                n.qualified_name,
                n.file_path,
                n.line_start ?? null,
                n.line_end ?? null,
                n.language ?? null,
                n.parent_name ?? null,
                n.params ?? null,
                n.return_type ?? null,
                n.modifiers ?? null,
                n.is_test ?? false,
                n.file_hash ?? null,
            );
            rows.push(
                `(${Array.from({ length: NODE_COL_COUNT }, (_, i) => `$${base + i + 1}`).join(',')})`,
            );
        }

        let sql = `INSERT INTO ast_nodes (
            repo_id, kind, name, qualified_name, file_path,
            line_start, line_end, language, parent_name,
            params, return_type, modifiers, is_test, file_hash
        ) VALUES ${rows.join(',')}`;

        if (onConflictIgnore) {
            sql += ` ON CONFLICT (repo_id, qualified_name) DO NOTHING`;
        }

        return { sql, params };
    }

    /**
     * Parameterized multi-row INSERT for ast_edges.
     */
    private buildEdgeInsertSQL(
        repoId: string,
        edges: GraphEdgeJson[],
        onConflictIgnore: boolean,
    ): { sql: string; params: any[] } {
        const params: any[] = [];
        const rows: string[] = [];

        for (const e of edges) {
            const base = params.length;
            params.push(
                repoId,
                e.kind,
                e.source_qualified,
                e.target_qualified,
                e.file_path,
                e.line ?? 0,
                e.confidence ?? null,
            );
            rows.push(
                `(${Array.from({ length: EDGE_COL_COUNT }, (_, i) => `$${base + i + 1}`).join(',')})`,
            );
        }

        let sql = `INSERT INTO ast_edges (
            repo_id, kind, source_qualified, target_qualified, file_path, line, confidence
        ) VALUES ${rows.join(',')}`;

        if (onConflictIgnore) {
            sql += ` ON CONFLICT (repo_id, kind, source_qualified, target_qualified) DO NOTHING`;
        }

        return { sql, params };
    }
}
