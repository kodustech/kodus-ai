import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

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
    constructor(
        // Kept for TypeORM module registration (forFeature).
        @InjectRepository(AstNodeModel)
        private readonly _nodeRepo: Repository<AstNodeModel>,
        @InjectRepository(AstEdgeModel)
        private readonly _edgeRepo: Repository<AstEdgeModel>,
        private readonly dataSource: DataSource,
    ) {}

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
    ): Promise<string> {
        if (changedFiles.length === 0) {
            return '{"sha":"","nodes":[],"edges":[]}';
        }

        const result = await this.dataSource.query(
            `WITH changed_nodes AS (
                SELECT qualified_name
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

        return result[0]?.graph_json || '{"sha":"","nodes":[],"edges":[]}';
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
