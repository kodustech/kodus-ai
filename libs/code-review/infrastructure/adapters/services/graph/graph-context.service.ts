import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphRepository } from '../../repositories/astGraph.repository';
import { KodusGraphCli, KODUS_GRAPH_TIMEOUTS } from './kodus-graph-cli';
import { shSingleQuote } from '../shell-quote';

const GRAPH_DIR = '.kodus-graph';
const GRAPH_PATH = `${GRAPH_DIR}/graph.json`;
const CONTEXT_OUTPUT_PATH = `${GRAPH_DIR}/context.xml`;
const BASE_GRAPH_PATH = `${GRAPH_DIR}/base-graph.json`;

/**
 * Generates per-PR graph context for code review. Reads the indexed baseline
 * from the DB (or falls back to reconstructing it from git history), parses
 * the PR's changed files in the sandbox, and produces a prompt string that
 * enriches the review agent with call-graph awareness.
 *
 * Does not mutate the persisted baseline — that is {@link GraphIndexerService}'s job.
 */
@Injectable()
export class GraphContextService {
    private readonly logger = createLogger(GraphContextService.name);

    constructor(
        private readonly astGraphRepo: AstGraphRepository,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
        private readonly cli: KodusGraphCli,
    ) {}

    /**
     * Generate context using DB graph as baseline.
     * Parses only changed files, exports base subgraph from DB, runs kodus-graph context.
     */
    async generateContext(
        sandbox: SandboxInstance,
        changedFiles: FileChange[],
        repoId: string,
    ): Promise<string> {
        if (!sandbox?.run) {
            this.logger.warn({
                message: `[KODUS-GRAPH] generateContext: sandbox has no run method, skipping`,
                context: GraphContextService.name,
                metadata: { repoId },
            });
            return '';
        }

        const filePaths = extractFilePaths(changedFiles);
        if (filePaths.length === 0) {
            this.logger.warn({
                message: `[KODUS-GRAPH] generateContext: no file paths extracted from ${changedFiles?.length} files`,
                context: GraphContextService.name,
            });
            return '';
        }

        try {
            this.logger.log({
                message: `[KODUS-GRAPH] Step 1/4: Installing kodus-graph...`,
                context: GraphContextService.name,
                metadata: { repoId, fileCount: filePaths.length },
            });
            await this.cli.install(sandbox);

            this.logger.log({
                message: `[KODUS-GRAPH] Step 2/4: Parsing ${filePaths.length} changed files...`,
                context: GraphContextService.name,
                metadata: { files: filePaths },
            });
            await this.cli.parseFiles(sandbox, filePaths, {
                outPath: GRAPH_PATH,
            });

            this.logger.log({
                message: `[KODUS-GRAPH] Step 3/4: Exporting subgraph from DB for repo ${repoId}...`,
                context: GraphContextService.name,
            });
            const repo = await this.repositoryService.findById(repoId);
            if (!repo) {
                this.logger.warn({
                    message: `[KODUS-GRAPH] Step 3/4: repo not found by UUID ${repoId}, falling back to legacy`,
                    context: GraphContextService.name,
                });
                return this.generateContextLegacy(sandbox, changedFiles);
            }
            await this.writeBaseGraphToSandbox(
                sandbox,
                repoId,
                filePaths,
                repo.astGraphSha ?? undefined,
            );

            const diffPath = await this.writeDiffToSandbox(
                sandbox,
                changedFiles,
            );
            this.logger.log({
                message: `[KODUS-GRAPH] Step 4/4: Generating prompt context with base graph...`,
                context: GraphContextService.name,
                metadata: { hasDiff: !!diffPath },
            });
            const prompt = await this.runContext(sandbox, filePaths, {
                graphPath: BASE_GRAPH_PATH,
                diffPath,
            });

            this.logger.log({
                message: `[KODUS-GRAPH] Context generated with DB baseline: ${prompt.length} chars`,
                context: GraphContextService.name,
                metadata: {
                    changedFiles: filePaths.length,
                    promptChars: prompt.length,
                    promptPreview: prompt.substring(0, 200),
                },
            });

            return prompt;
        } catch (error) {
            this.logger.warn({
                message: `[KODUS-GRAPH] Failed with DB baseline, falling back to legacy`,
                context: GraphContextService.name,
                error,
                metadata: { repoId, fileCount: filePaths.length },
            });
            return this.generateContextLegacy(sandbox, changedFiles);
        }
    }

    /**
     * Parse changed files and return the raw graph JSON (nodes + edges).
     * Used by EE pipeline to provide structured graph data for content formatting.
     * Returns null on any failure (non-blocking).
     */
    async parseAndGetGraphJson(
        sandbox: SandboxInstance,
        changedFiles: FileChange[],
    ): Promise<{ nodes: any[]; edges: any[] } | null> {
        if (!sandbox?.run) return null;

        const filePaths = extractFilePaths(changedFiles);
        if (filePaths.length === 0) return null;

        try {
            await this.cli.install(sandbox);
            await this.cli.parseFiles(sandbox, filePaths, {
                outPath: GRAPH_PATH,
            });

            const graphContent = await sandbox.readFile(
                `${sandbox.repoDir}/${GRAPH_PATH}`,
                { timeoutMs: 10_000 },
            );
            const json = JSON.parse(graphContent || '{}');
            const nodes = json?.nodes ?? [];
            const edges = json?.edges ?? [];

            this.logger.log({
                message: `[KODUS-GRAPH] Graph JSON extracted: ${nodes.length} nodes, ${edges.length} edges`,
                context: GraphContextService.name,
                metadata: {
                    fileCount: filePaths.length,
                    nodeCount: nodes.length,
                    edgeCount: edges.length,
                },
            });

            return nodes.length > 0 ? { nodes, edges } : null;
        } catch (error) {
            this.logger.warn({
                message: `[KODUS-GRAPH] Failed to parse graph JSON, skipping`,
                context: GraphContextService.name,
                error,
                metadata: { fileCount: filePaths.length },
            });
            return null;
        }
    }

    /**
     * Legacy flow: parse changed files, optionally building a baseline graph
     * from the base branch via `git show` (read-only). Enables contract_diffs
     * without a DB baseline. Falls back gracefully on failure.
     */
    async generateContextLegacy(
        sandbox: SandboxInstance,
        changedFiles: FileChange[],
        baseBranch?: string,
    ): Promise<string> {
        this.logger.log({
            message: `[KODUS-GRAPH] generateContextLegacy called: changedFiles=${changedFiles?.length}, baseBranch=${baseBranch || 'none'}, sandboxType=${sandbox?.type}`,
            context: GraphContextService.name,
        });

        if (!sandbox?.run) {
            this.logger.warn({
                message: `[KODUS-GRAPH] No sandbox available, skipping`,
                context: GraphContextService.name,
            });
            return '';
        }

        const filePaths = extractFilePaths(changedFiles);

        if (filePaths.length === 0) {
            this.logger.warn({
                message: `[KODUS-GRAPH] No file paths extracted from ${changedFiles?.length} changed files, skipping`,
                context: GraphContextService.name,
            });
            return '';
        }

        try {
            await this.cli.install(sandbox);

            const diffPath = await this.writeDiffToSandbox(
                sandbox,
                changedFiles,
            );

            let baseGraphPath: string | undefined;
            if (baseBranch) {
                baseGraphPath = await this.buildBaseGraphFromGit(
                    sandbox,
                    filePaths,
                    baseBranch,
                );
            }

            const prompt = await this.runContext(sandbox, filePaths, {
                graphPath: baseGraphPath,
                diffPath,
            });

            this.logger.log({
                message: `[KODUS-GRAPH] Context generated: ${prompt.length} chars for ${filePaths.length} changed files (baseGraph=${baseGraphPath ? 'yes' : 'no'})`,
                context: GraphContextService.name,
                metadata: {
                    changedFiles: filePaths.length,
                    promptChars: prompt.length,
                    hasBaseGraph: !!baseGraphPath,
                    baseBranch: baseBranch || 'none',
                    promptPreview: prompt.substring(0, 320),
                },
            });

            return prompt;
        } catch (error) {
            this.logger.warn({
                message: `[KODUS-GRAPH] Failed to generate context, proceeding without it`,
                context: GraphContextService.name,
                error,
            });
            return '';
        }
    }

    /**
     * Build a baseline graph from the base branch using git history.
     * Uses `git show origin/<baseBranch>:<file>` (read-only) to get old versions
     * of changed files, parses them with kodus-graph. Returns undefined on any failure.
     */
    private async buildBaseGraphFromGit(
        sandbox: SandboxInstance,
        filePaths: string[],
        baseBranch: string,
    ): Promise<string | undefined> {
        const BASE_FILES_DIR = `${GRAPH_DIR}/base-files`;

        // Reject branch names that contain characters git wouldn't accept or
        // that would break our shell interpolation. Keeping this as a hard
        // rejection (not an escape) because any legitimate base branch we
        // review fits easily in [A-Za-z0-9._/@+-].
        if (!/^[A-Za-z0-9._\-/@+]+$/.test(baseBranch)) {
            this.logger.warn({
                message: `[KODUS-GRAPH] buildBaseGraphFromGit: baseBranch contains unsupported characters, skipping`,
                context: GraphContextService.name,
                metadata: { baseBranch },
            });
            return undefined;
        }

        try {
            const escapedFiles = filePaths.map(
                (f) => `'${f.replace(/'/g, "'\\''")}'`,
            );
            const fileList = escapedFiles.join(' ');
            // Shell-escape the ref prefix so even if validation above is ever
            // relaxed, the `git show` arg can't be abused. `$f` intentionally
            // stays unquoted so the shell loop variable expands.
            const safeBaseRef = shSingleQuote(`origin/${baseBranch}`);

            const extractResult = await sandbox.run(
                [
                    `cd ${sandbox.repoDir}`,
                    `rm -rf ${BASE_FILES_DIR} && mkdir -p ${BASE_FILES_DIR}`,
                    // `${f%/*}` is POSIX parameter expansion — it strips the
                    // last `/...` from the path without spawning a subshell.
                    // The previous `$(dirname "$f")` form invoked a command
                    // substitution inside the shell loop, which meant a
                    // filename like `dir/$(reboot).txt` would execute in the
                    // sandbox. Parameter expansion is a pure text operation
                    // and can't be abused by filename content.
                    `for f in ${fileList}; do ` +
                        `d="${BASE_FILES_DIR}/\${f%/*}" && ` +
                        `mkdir -p "$d" 2>/dev/null; ` +
                        `git show ${safeBaseRef}":$f" > "${BASE_FILES_DIR}/$f" 2>/dev/null || rm -f "${BASE_FILES_DIR}/$f"; ` +
                        `done`,
                    `find ${BASE_FILES_DIR} -type f -size +0c | sed 's|^${BASE_FILES_DIR}/||' | sort`,
                ].join(' && '),
                { timeoutMs: 30_000 },
            );

            if (extractResult.exitCode !== 0) {
                this.logger.warn({
                    message: `[KODUS-GRAPH] buildBaseGraphFromGit: extract failed (exit=${extractResult.exitCode})`,
                    context: GraphContextService.name,
                    metadata: {
                        stderr: (extractResult.stderr || '').slice(0, 300),
                    },
                });
                return undefined;
            }

            const extractedFiles = (extractResult.stdout || '')
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean);

            if (extractedFiles.length === 0) {
                this.logger.log({
                    message: `[KODUS-GRAPH] buildBaseGraphFromGit: no old files found on origin/${baseBranch} (all ${filePaths.length} files are new)`,
                    context: GraphContextService.name,
                });
                return undefined;
            }

            await this.cli.parseFiles(sandbox, extractedFiles, {
                outPath: BASE_GRAPH_PATH,
                repoDir: BASE_FILES_DIR,
                timeoutMs: KODUS_GRAPH_TIMEOUTS.parseFiles,
            });

            this.logger.log({
                message: `[KODUS-GRAPH] buildBaseGraphFromGit: base graph built from ${extractedFiles.length}/${filePaths.length} files on origin/${baseBranch}`,
                context: GraphContextService.name,
                metadata: {
                    baseBranch,
                    extractedFiles: extractedFiles.length,
                    totalFiles: filePaths.length,
                },
            });

            return BASE_GRAPH_PATH;
        } catch (error) {
            this.logger.warn({
                message: `[KODUS-GRAPH] buildBaseGraphFromGit: unexpected error, proceeding without base graph`,
                context: GraphContextService.name,
                error,
            });
            return undefined;
        }
    }

    private async writeBaseGraphToSandbox(
        sandbox: SandboxInstance,
        repoId: string,
        changedFiles: string[],
        sha?: string,
    ): Promise<void> {
        // Filtered subgraph: only nodes in changed files + direct neighbors.
        // ~99% reduction vs full export (e.g. ~500 nodes instead of 50k+).
        const jsonStr = await this.astGraphRepo.exportSubgraphJsonString(
            repoId,
            changedFiles,
            sha,
        );
        const baseGraphPath = `${sandbox.repoDir}/${BASE_GRAPH_PATH}`;

        this.logger.log({
            message: `[KODUS-GRAPH] Step 3/4: Subgraph exported: ${jsonStr.length} chars, writing to sandbox at ${baseGraphPath}`,
            context: GraphContextService.name,
            metadata: {
                repoId,
                changedFiles,
                subgraphChars: jsonStr.length,
                sha,
            },
        });

        await sandbox.writeFile(baseGraphPath, jsonStr);
    }

    /**
     * Build a unified diff from changedFiles patches and write it to the sandbox.
     * Used so kodus-graph can filter changed functions by actual diff lines.
     */
    private async writeDiffToSandbox(
        sandbox: SandboxInstance,
        changedFiles: FileChange[],
    ): Promise<string | undefined> {
        const patches: string[] = [];
        for (const file of changedFiles) {
            const rawPatch = file.patch || file.patchWithLinesStr;
            if (!rawPatch) continue;
            const filePath = file.filename || file.previous_filename || '';
            if (!filePath) continue;

            let patchBody: string;
            if (file.patch) {
                patchBody = file.patch;
            } else {
                // patchWithLinesStr format: "## file: '...'" header + line-numbered content.
                // Strip header and line-number prefix — parseDiffHunks only needs @@ headers.
                patchBody = rawPatch
                    .split('\n')
                    .filter((line) => !line.startsWith('## file:'))
                    .map((line) => {
                        const m = line.match(/^\s*\d+\s([+ -].*)/);
                        return m ? m[1] : line;
                    })
                    .join('\n');
            }

            const patchNormalized = patchBody.endsWith('\n')
                ? patchBody
                : `${patchBody}\n`;
            patches.push(
                `--- a/${filePath}\n+++ b/${filePath}\n${patchNormalized}`,
            );
        }
        if (patches.length === 0) {
            this.logger.warn({
                message: `[KODUS-GRAPH] No patches found in changedFiles, skipping diff write`,
                context: GraphContextService.name,
            });
            return undefined;
        }
        const diffContent = patches.join('\n');
        const diffPath = `${sandbox.repoDir}/${GRAPH_DIR}/pr.diff`;
        await sandbox.run(`mkdir -p ${sandbox.repoDir}/${GRAPH_DIR}`, {
            timeoutMs: 5_000,
        });
        await sandbox.writeFile(diffPath, diffContent);
        this.logger.log({
            message: `[KODUS-GRAPH] Diff written to sandbox: ${diffContent.length} chars, ${patches.length} files`,
            context: GraphContextService.name,
            metadata: {
                diffChars: diffContent.length,
                filesWithPatch: patches.length,
            },
        });
        return `${GRAPH_DIR}/pr.diff`;
    }

    private async runContext(
        sandbox: SandboxInstance,
        filePaths: string[],
        options: { graphPath?: string; diffPath?: string },
    ): Promise<string> {
        await this.cli.context(sandbox, filePaths, {
            outPath: CONTEXT_OUTPUT_PATH,
            graphPath: options.graphPath,
            diffPath: options.diffPath,
        });

        try {
            return await sandbox.readFile(
                `${sandbox.repoDir}/${CONTEXT_OUTPUT_PATH}`,
                { timeoutMs: 10_000 },
            );
        } catch {
            this.logger.warn({
                message: `[KODUS-GRAPH] prompt file is empty (context command succeeded but produced no output)`,
                context: GraphContextService.name,
            });
            return '';
        }
    }
}

function extractFilePaths(changedFiles: FileChange[]): string[] {
    return (changedFiles || [])
        .map((f) => f.filename || f.previous_filename)
        .filter(Boolean) as string[];
}
