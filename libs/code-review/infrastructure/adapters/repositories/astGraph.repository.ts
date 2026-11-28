import {
    GraphBaselineChangedError,
    GraphJobAttempt,
    StaleGraphJobError,
} from '@libs/code-review/domain/graph-job-attempt';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    DataSource,
    EntityManager,
    In,
    JsonContains,
    Repository,
} from 'typeorm';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';

import { AstNodeModel } from './schemas/astNode.model';
import { AstEdgeModel } from './schemas/astEdge.model';
import { AstGraphStatus, RepositoryModel } from './schemas/repository.model';

interface GraphRevision {
    job?: GraphJobAttempt;
    sha?: string;
    expectedSha?: string | null;
    signal?: AbortSignal;
}

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
            await manager.query(`DELETE FROM ast_edges WHERE repo_id = $1`, [
                repoId,
            ]);
            await manager.query(`DELETE FROM ast_nodes WHERE repo_id = $1`, [
                repoId,
            ]);
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
        revision?: GraphRevision,
    ): Promise<{ nodeCount: number; edgeCount: number }> {
        return this.writeGraph(repoId, nodes, edges, revision);
    }

    async incrementalUpdate(
        repoId: string,
        filePaths: string[],
        nodes: GraphNodeJson[],
        edges: GraphEdgeJson[],
        revision?: GraphRevision,
    ): Promise<{ nodeCount: number; edgeCount: number }> {
        return this.writeGraph(repoId, nodes, edges, revision, filePaths);
    }

    private async writeGraph(
        repoId: string,
        nodes: GraphNodeJson[],
        edges: GraphEdgeJson[],
        revision?: GraphRevision,
        filePaths?: string[],
    ): Promise<{ nodeCount: number; edgeCount: number }> {
        const signal = revision?.signal;
        return this.dataSource.transaction(async (manager) => {
            signal?.throwIfAborted();
            // Serialize writers before they replace rows or count a revision.
            await this.lockRepository(manager, repoId, revision);
            if (!filePaths || filePaths.length) {
                const where = filePaths
                    ? 'repo_id = $1 AND file_path = ANY($2::text[])'
                    : 'repo_id = $1';
                const params = filePaths ? [repoId, filePaths] : [repoId];
                signal?.throwIfAborted();
                await manager.query(
                    `DELETE FROM ast_edges WHERE ${where}`,
                    params,
                );
                signal?.throwIfAborted();
                await manager.query(
                    `DELETE FROM ast_nodes WHERE ${where}`,
                    params,
                );
            }

            for (let i = 0; i < nodes.length; i += NODE_CHUNK_SIZE) {
                signal?.throwIfAborted();
                const { sql, params } = this.buildNodeInsertSQL(
                    repoId,
                    nodes.slice(i, i + NODE_CHUNK_SIZE),
                    true,
                );
                await manager.query(sql, params);
            }
            for (let i = 0; i < edges.length; i += EDGE_CHUNK_SIZE) {
                signal?.throwIfAborted();
                const { sql, params } = this.buildEdgeInsertSQL(
                    repoId,
                    edges.slice(i, i + EDGE_CHUNK_SIZE),
                    true,
                );
                await manager.query(sql, params);
            }

            signal?.throwIfAborted();
            return this.finishGraphWrite(manager, repoId, revision);
        });
    }

    private async lockRepository(
        manager: EntityManager,
        repoId: string,
        revision?: GraphRevision,
    ): Promise<void> {
        const locked = await manager.findOneOrFail(RepositoryModel, {
            select: { uuid: true, astGraphSha: true },
            where: { uuid: repoId },
            lock: { mode: 'for_no_key_update' },
        });
        if (
            revision?.expectedSha !== undefined &&
            locked.astGraphSha !== revision.expectedSha &&
            locked.astGraphSha !== revision.sha
        ) {
            throw new GraphBaselineChangedError();
        }
    }

    async updateBuildStatus(
        repoId: string,
        status: AstGraphStatus.BUILDING | AstGraphStatus.FAILED,
        revision?: GraphRevision,
    ): Promise<void> {
        const { signal, job } = revision ?? {};
        await this.dataSource.transaction(async (manager) => {
            signal?.throwIfAborted();
            await this.lockRepository(manager, repoId, revision);
            await this.lockJob(manager, job);
            signal?.throwIfAborted();
            await manager.update(
                RepositoryModel,
                { uuid: repoId },
                {
                    astGraphStatus: status,
                },
            );
            signal?.throwIfAborted();
        });
    }

    async failBuildForAttempt(
        repoId: string,
        job: GraphJobAttempt,
    ): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            await this.lockRepository(manager, repoId);
            await this.lockJob(manager, job, JobStatus.FAILED);
            await manager.update(
                RepositoryModel,
                {
                    uuid: repoId,
                    astGraphStatus: In([
                        AstGraphStatus.PENDING,
                        AstGraphStatus.BUILDING,
                    ]),
                },
                { astGraphStatus: AstGraphStatus.FAILED },
            );
        });
    }

    private async lockJob(
        manager: EntityManager,
        job?: GraphJobAttempt,
        status = JobStatus.PROCESSING,
    ): Promise<void> {
        if (!job) return;
        // A retry can reuse the job ID. Only the current attempt may publish it.
        // Hold through COMMIT so a concurrent failure cannot become visible first.
        const active = await manager.findOne(WorkflowJobModel, {
            select: { uuid: true },
            where: {
                uuid: job.jobId,
                status,
                metadata: JsonContains({ attemptId: job.attemptId }),
            },
            lock: { mode: 'pessimistic_read' },
        });
        if (!active) throw new StaleGraphJobError(job.jobId);
    }

    private async finishGraphWrite(
        manager: EntityManager,
        repoId: string,
        revision?: GraphRevision,
    ): Promise<{ nodeCount: number; edgeCount: number }> {
        // Count the stored rows: ON CONFLICT can skip duplicate parser output.
        const [counts] = await manager.query(
            `SELECT (SELECT count(*)::int FROM ast_nodes WHERE repo_id = $1) AS "nodeCount",
                    (SELECT count(*)::int FROM ast_edges WHERE repo_id = $1) AS "edgeCount"`,
            [repoId],
        );
        if (revision) {
            revision.signal?.throwIfAborted();
            await this.lockJob(manager, revision.job);
            revision.signal?.throwIfAborted();
            // Publish the SHA, counts and rows in one transaction. An abort during
            // any of these writes must leave the previous revision intact.
            await manager.update(
                RepositoryModel,
                { uuid: repoId },
                {
                    astGraphStatus: AstGraphStatus.READY,
                    astGraphBuiltAt: new Date(),
                    astGraphSha: revision.sha,
                    astGraphNodeCount: counts.nodeCount,
                    astGraphEdgeCount: counts.edgeCount,
                },
            );
            revision.signal?.throwIfAborted();
        }
        return counts;
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
     * Uses idx_ast_edges_repo_source (repo_id, source_qualified) and
     * idx_ast_edges_repo_target (repo_id, target_qualified): each endpoint is
     * its own indexed join, merged with UNION. The previous form,
     * `source_qualified IN (...) OR target_qualified IN (...)`, cannot use
     * either index; Postgres read every edge of the repo through the
     * repo_id-only index and filtered them against both subqueries. Its cost
     * followed the size of the repo's graph, not the PR: in production
     * (2026-11-23, 24h) 859 runs over the slow-query threshold, p50 6.6s,
     * max 29.7s, and 30s statement timeouts on PRs that changed 1 file. On a
     * local Postgres 16 with a 1.6M-edge repo the same plan read 1,599,993
     * edges to return 65 (582-802ms); this form returns the same nodes and
     * edges in 2-21ms.
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
            -- Edges touching changed nodes (direct neighbors). One indexed
            -- join per endpoint: an OR of two IN subqueries cannot use
            -- idx_ast_edges_repo_source/_target and filters every edge of
            -- the repo instead (see the method comment).
            touching_edges AS (
                SELECT e.*
                FROM ast_edges e
                JOIN changed_nodes c ON e.source_qualified = c.qualified_name
                WHERE e.repo_id = $1
                UNION
                SELECT e.*
                FROM ast_edges e
                JOIN changed_nodes c ON e.target_qualified = c.qualified_name
                WHERE e.repo_id = $1
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
                JOIN sibling_classes s ON e.source_qualified = s.qn
                WHERE e.repo_id = $1
                  AND e.kind IN ('INHERITS', 'CONTAINS')
                UNION
                SELECT e.*
                FROM ast_edges e
                JOIN sibling_classes s ON e.target_qualified = s.qn
                WHERE e.repo_id = $1
                  AND e.kind IN ('INHERITS', 'CONTAINS')
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
