import {
    GraphJobAttempt,
    StaleGraphJobError,
} from '@libs/code-review/domain/graph-job-attempt';
import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { posix } from 'node:path';
import { AstGraphRepository } from '../../repositories/astGraph.repository';
import { AstGraphStatus } from '../../repositories/schemas/repository.model';
import { KodusGraphCli } from './kodus-graph-cli';

const GRAPH_DIR = '.kodus-graph';
const GRAPH_PATH = `${GRAPH_DIR}/graph.json`;

const READ_FILE_TIMEOUT_MS = 600_000;

const DEFAULT_EXCLUDES = [
    '**/tests/**',
    '**/test/**',
    '**/__tests__/**',
    '**/test_*',
    '**/*.test.*',
    '**/*.spec.*',
    '**/fixtures/**',
    '**/static/**',
    '**/__mocks__/**',
    '**/.yarn/**',
    '**/node_modules/**',
    '**/vendor/**',
    '**/dist/**',
    '**/build/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.bundle.js',
    '**/*.chunk.js',
];

/** Repos above this threshold get a warning log before persist */
const LARGE_REPO_NODE_THRESHOLD = 50_000;

/**
 * Maintains the persisted graph baseline for a repository (main branch).
 * Runs offline via job processors; writes nodes/edges to the DB so per-PR
 * reviews can consume a subgraph without re-parsing the whole repo.
 */
@Injectable()
export class GraphIndexerService {
    private readonly logger = createLogger(GraphIndexerService.name);

    constructor(
        private readonly astGraphRepo: AstGraphRepository,
        private readonly cli: KodusGraphCli,
    ) {}

    failBuildForAttempt(
        repositoryId: string,
        job: GraphJobAttempt,
    ): Promise<void> {
        return this.astGraphRepo.failBuildForAttempt(repositoryId, job);
    }

    /**
     * Full build: parse entire repo and persist to DB.
     */
    async fullBuild(params: {
        repositoryId: string;
        sandbox: SandboxInstance;
        headSha: string;
        signal?: AbortSignal;
        job?: GraphJobAttempt;
        expectedSha?: string | null;
    }): Promise<void> {
        const { repositoryId, sandbox, headSha, signal, job } = params;
        signal?.throwIfAborted();
        const revision = {
            sha: headSha,
            expectedSha: params.expectedSha,
            job,
            signal,
        };
        const buildStart = Date.now();

        this.logger.log({
            message: `[AST-GRAPH] Starting full build for repo ${repositoryId}`,
            context: GraphIndexerService.name,
            metadata: { repositoryId, headSha },
        });

        await this.astGraphRepo.updateBuildStatus(
            repositoryId,
            AstGraphStatus.BUILDING,
            revision,
        );

        try {
            const installStart = Date.now();
            await this.cli.install(sandbox, signal);
            this.logger.log({
                message: `[AST-GRAPH] kodus-graph installed (${Date.now() - installStart}ms)`,
                context: GraphIndexerService.name,
                metadata: { repositoryId },
            });

            signal?.throwIfAborted();
            const parseStart = Date.now();
            const { stderr: parseStderr } = await this.cli.parseAll(sandbox, {
                outPath: GRAPH_PATH,
                excludePatterns: DEFAULT_EXCLUDES,
                signal,
            });

            this.logger.log({
                message: `[AST-GRAPH] Parse completed (${Date.now() - parseStart}ms)`,
                context: GraphIndexerService.name,
                metadata: {
                    repositoryId,
                    parseStderr: parseStderr.slice(0, 300),
                },
            });

            signal?.throwIfAborted();
            const { nodes, edges } = await this.readGraphFromSandbox(
                sandbox,
                repositoryId,
            );

            signal?.throwIfAborted();
            if (nodes.length === 0) {
                this.logger.warn({
                    message: `[AST-GRAPH] Parse produced 0 nodes for repo ${repositoryId} — marking as FAILED`,
                    context: GraphIndexerService.name,
                    metadata: { repositoryId, headSha },
                });
                await this.astGraphRepo.updateBuildStatus(
                    repositoryId,
                    AstGraphStatus.FAILED,
                    revision,
                );
                return;
            }

            const persistStart = Date.now();
            const counts = await this.astGraphRepo.fullRebuild(
                repositoryId,
                nodes,
                edges,
                revision,
            );

            this.logger.log({
                message: `[AST-GRAPH] DB persist completed (${Date.now() - persistStart}ms)`,
                context: GraphIndexerService.name,
                metadata: {
                    repositoryId,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                },
            });

            const totalMs = Date.now() - buildStart;
            this.logger.log({
                message: `[AST-GRAPH] Full build COMPLETE for repo ${repositoryId} in ${totalMs}ms — ${counts.nodeCount} nodes, ${counts.edgeCount} edges`,
                context: GraphIndexerService.name,
                metadata: {
                    repositoryId,
                    headSha,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                    durationMs: totalMs,
                },
            });
        } catch (error) {
            if (error instanceof StaleGraphJobError) throw error;
            // The processor owns the failure transition once the job is aborted.
            signal?.throwIfAborted();
            const totalMs = Date.now() - buildStart;
            if (!job) {
                await this.astGraphRepo.updateBuildStatus(
                    repositoryId,
                    AstGraphStatus.FAILED,
                    revision,
                );
            }
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.error({
                message: `[AST-GRAPH] Full build FAILED for repo ${repositoryId} after ${totalMs}ms — ${errorMessage}`,
                context: GraphIndexerService.name,
                metadata: { repositoryId, headSha, durationMs: totalMs },
            });
            throw error;
        }
    }

    /**
     * Incremental update: parse only changed files and update DB.
     */
    async incrementalUpdate(params: {
        repositoryId: string;
        sandbox: SandboxInstance;
        changedFiles: string[] | null;
        newSha: string;
        signal?: AbortSignal;
        job?: GraphJobAttempt;
        expectedSha?: string | null;
    }): Promise<void> {
        const { repositoryId, sandbox, newSha, signal, job } = params;
        signal?.throwIfAborted();
        // Azure reports paths from the repository root with a leading slash.
        // The parser and the stored graph both use repository-relative paths.
        const changedFiles = params.changedFiles?.map((file) =>
            posix.normalize(file).replace(/^\/+/, ''),
        );
        const revision = {
            sha: newSha,
            expectedSha: params.expectedSha,
            signal,
            job,
        };
        if (changedFiles?.length === 0) {
            await this.astGraphRepo.incrementalUpdate(
                repositoryId,
                [],
                [],
                [],
                revision,
            );
            return;
        }
        const updateStart = Date.now();

        this.logger.log({
            message: `[AST-GRAPH] Starting incremental update: ${changedFiles?.length ?? 'all'} files for repo ${repositoryId}`,
            context: GraphIndexerService.name,
            metadata: {
                repositoryId,
                newSha,
                changedFilesCount: changedFiles?.length,
                changedFiles: changedFiles?.slice(0, 20),
            },
        });

        try {
            const installStart = Date.now();
            await this.cli.install(sandbox, signal);
            this.logger.log({
                message: `[AST-GRAPH] kodus-graph installed (${Date.now() - installStart}ms)`,
                context: GraphIndexerService.name,
                metadata: { repositoryId },
            });

            signal?.throwIfAborted();
            const parseStart = Date.now();
            if (changedFiles) {
                await this.cli.parseFiles(sandbox, changedFiles, {
                    signal,
                    outPath: GRAPH_PATH,
                });
            } else {
                await this.cli.parseAll(sandbox, {
                    signal,
                    outPath: GRAPH_PATH,
                    excludePatterns: DEFAULT_EXCLUDES,
                });
            }

            this.logger.log({
                message: `[AST-GRAPH] Incremental parse completed (${Date.now() - parseStart}ms)`,
                context: GraphIndexerService.name,
                metadata: {
                    repositoryId,
                    changedFilesCount: changedFiles?.length,
                },
            });

            signal?.throwIfAborted();
            const { nodes, edges } = await this.readGraphFromSandbox(
                sandbox,
                repositoryId,
            );

            signal?.throwIfAborted();
            const persistStart = Date.now();
            const counts = changedFiles
                ? await this.astGraphRepo.incrementalUpdate(
                      repositoryId,
                      changedFiles,
                      nodes,
                      edges,
                      revision,
                  )
                : await this.astGraphRepo.fullRebuild(
                      repositoryId,
                      nodes,
                      edges,
                      revision,
                  );

            this.logger.log({
                message: `[AST-GRAPH] Incremental DB persist completed (${Date.now() - persistStart}ms)`,
                context: GraphIndexerService.name,
                metadata: {
                    repositoryId,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                },
            });

            const totalMs = Date.now() - updateStart;
            this.logger.log({
                message: `[AST-GRAPH] Incremental update COMPLETE for repo ${repositoryId} in ${totalMs}ms — ${counts.nodeCount} nodes, ${counts.edgeCount} edges from ${changedFiles?.length ?? 'all'} files`,
                context: GraphIndexerService.name,
                metadata: {
                    repositoryId,
                    newSha,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                    changedFilesCount: changedFiles?.length,
                    durationMs: totalMs,
                },
            });
        } catch (error) {
            const totalMs = Date.now() - updateStart;
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.warn({
                message: `[AST-GRAPH] Incremental update FAILED for repo ${repositoryId} after ${totalMs}ms — ${errorMessage}`,
                context: GraphIndexerService.name,
                metadata: {
                    repositoryId,
                    newSha,
                    changedFilesCount: changedFiles?.length,
                    durationMs: totalMs,
                },
            });
            // Don't set status to failed — graph is stale but still usable
            throw error;
        }
    }

    private async readGraphFromSandbox(
        sandbox: SandboxInstance,
        repositoryId: string,
    ): Promise<{ nodes: any[]; edges: any[] }> {
        const readStart = Date.now();
        const filePath = `${sandbox.repoDir}/${GRAPH_PATH}`;

        let rawJson: string;
        try {
            rawJson = await sandbox.readFile(filePath, {
                timeoutMs: READ_FILE_TIMEOUT_MS,
            });
        } catch (err) {
            const errorMessage =
                err instanceof Error ? err.message : String(err);
            throw new Error(
                `Failed to read graph file from sandbox (${filePath}): ${errorMessage}`,
                { cause: err },
            );
        }

        if (!rawJson || rawJson.length === 0) {
            throw new Error('kodus-graph parse produced empty output file');
        }

        const graphData = JSON.parse(rawJson);

        const nodes = graphData.nodes || [];
        const edges = graphData.edges || [];

        this.logger.log({
            message: `[AST-GRAPH] Graph read from sandbox (${Date.now() - readStart}ms): ${nodes.length} nodes, ${edges.length} edges`,
            context: GraphIndexerService.name,
            metadata: {
                repositoryId,
                nodeCount: nodes.length,
                edgeCount: edges.length,
            },
        });

        if (nodes.length > LARGE_REPO_NODE_THRESHOLD) {
            this.logger.warn({
                message: `[AST-GRAPH] Large repo detected: ${nodes.length} nodes for ${repositoryId} — persist may be slow`,
                context: GraphIndexerService.name,
                metadata: {
                    repositoryId,
                    nodeCount: nodes.length,
                    edgeCount: edges.length,
                },
            });
        }

        return { nodes, edges };
    }
}
