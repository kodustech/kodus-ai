import { Inject, Injectable, Logger } from '@nestjs/common';

import {
    changedSourceFiles,
    mapAnalyzeJsonToL1GateVerdict,
    type GateVerdict,
    type L1Verdict,
} from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import type {
    L1AssessInput,
    L1Assessor,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { KodusGraphCli } from '@libs/code-review/infrastructure/adapters/services/graph/kodus-graph-cli';

/**
 * The L1 gate adapter: `kodus-graph analyze` over the PR's changed files
 * against the repository's persisted baseline graph.
 *
 * Per `design.md §Decision 3` the L1 stream is the graph metric. This adapter
 * is the concrete half of the `L1Assessor` port; the reconciler itself stays
 * free of any CLI or sandbox knowledge.
 *
 * The baseline graph:
 *
 *   The graph is built offline by `AstGraphBuildJobProcessor` and persisted
 *   in the database (`ast_nodes` / `ast_edges`), NOT as a file in the
 *   repository. A per-PR review therefore exports a filtered subgraph of
 *   the baseline into the sandbox before the graph tooling runs
 *   (`GraphContextService.writeBaseGraphToSandbox` → `.kodus-graph/base-graph.json`).
 *   That export only happens when the repository's `astGraphStatus` is
 *   `READY`; otherwise the review falls back to the legacy path, which
 *   produces no baseline file.
 *
 *   So L1 has exactly two honest options: read the file the export wrote,
 *   or report `Unavailable`. This adapter reads the file and reports
 *   `Unavailable` when it is absent — which is the truth, and per Q1
 *   (ratified) `Unavailable` contributes nothing to the decision: the
 *   reducer escalates to L2 instead of vetoing.
 *
 * Every failure path — no sandbox, no changed source files, a missing
 * baseline graph, a non-zero CLI exit, unparsable output — surfaces as
 * `Unavailable(reason)`, never as an exception and never as a silent
 * approval.
 */
@Injectable()
export class PrDecisionL1AssessorService implements L1Assessor {
    private readonly logger = new Logger(PrDecisionL1AssessorService.name);

    /** Where the analyze output lands inside the sandbox. */
    private static readonly OUT_PATH = '.kodus-graph/analyze.json';

    /**
     * Where the baseline subgraph is written inside the sandbox. The same
     * path `GraphContextService` writes it to
     * (`graph-context.service.ts` — `BASE_GRAPH_PATH`).
     */
    private static readonly BASE_GRAPH_PATH = '.kodus-graph/base-graph.json';

    constructor(
        private readonly cli: KodusGraphCli,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
    ) {}

    async assess(input: L1AssessInput): Promise<GateVerdict<L1Verdict>> {
        const sandbox = input.sandbox;
        if (!sandbox) {
            return {
                status: 'Unavailable',
                reason: 'No sandbox is available for the graph analysis (L1 cannot run).',
                snapshotKey: input.snapshotKey,
            };
        }

        const files = changedSourceFiles(
            input.changedFiles.map((f) => ({
                filename: f.filename,
                status: f.status,
            })) as any,
        );
        if (files.length === 0) {
            return {
                status: 'Unavailable',
                reason: 'The PR has no changed source files to analyze (L1 has nothing to measure).',
                snapshotKey: input.snapshotKey,
            };
        }

        // The baseline only exists in the sandbox when the repository's graph
        // was built. Checking the status first avoids a pointless CLI call
        // and gives the audit panel an exact reason.
        const graphStatus = await this.graphStatus(input);
        if (graphStatus !== AstGraphStatus.READY) {
            return {
                status: 'Unavailable',
                reason: `The repository has no graph baseline (astGraphStatus=${graphStatus}). Build it before relying on L1.`,
                snapshotKey: input.snapshotKey,
            };
        }

        // The baseline subgraph is only in the sandbox if the review's graph
        // context step wrote it. Read it first: a missing file is the
        // honest "no baseline" answer, not a CLI error.
        const baseGraphPath = `${sandbox.repoDir ?? '.'}/${PrDecisionL1AssessorService.BASE_GRAPH_PATH}`;
        if (!(await this.exists(sandbox, baseGraphPath))) {
            return {
                status: 'Unavailable',
                reason: `No graph baseline in the sandbox at ${PrDecisionL1AssessorService.BASE_GRAPH_PATH}.`,
                snapshotKey: input.snapshotKey,
            };
        }

        try {
            await this.cli.install(sandbox);
            await this.cli.analyzeFiles(sandbox, files, {
                outPath: PrDecisionL1AssessorService.OUT_PATH,
                graphPath: PrDecisionL1AssessorService.BASE_GRAPH_PATH,
                repoDir: sandbox.repoDir ?? '.',
            });

            const raw = await sandbox.readFile(
                `${sandbox.repoDir ?? '.'}/${PrDecisionL1AssessorService.OUT_PATH}`,
                { timeoutMs: 30_000 },
            );
            return mapAnalyzeJsonToL1GateVerdict(raw, input.snapshotKey, raw);
        } catch (error) {
            const reason =
                error instanceof Error
                    ? error.message
                    : String(error ?? 'unknown error');
            this.logger.warn?.({
                message: `[pr-decision] L1 graph analysis unavailable: ${reason}`,
                context: PrDecisionL1AssessorService.name,
                metadata: {
                    repositoryId: input.repositoryId,
                    prNumber: input.prNumber,
                    fileCount: files.length,
                },
            });
            return {
                status: 'Unavailable',
                reason: `kodus-graph analyze failed: ${reason}`,
                snapshotKey: input.snapshotKey,
            };
        }
    }

    /**
     * The repository's graph status. The baseline is exported into the
     * sandbox only for a `READY` repository, so this is the gate that
     * decides whether L1 can run at all.
     */
    private async graphStatus(input: L1AssessInput): Promise<AstGraphStatus> {
        try {
            const repo = await this.repositoryService.findByExternalId(
                input.platform ?? '',
                String(input.repositoryId),
            );
            return repo?.astGraphStatus ?? AstGraphStatus.PENDING;
        } catch (error) {
            this.logger.warn?.({
                message:
                    '[pr-decision] could not read the repository graph status',
                context: PrDecisionL1AssessorService.name,
                metadata: {
                    repositoryId: input.repositoryId,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
            return AstGraphStatus.PENDING;
        }
    }

    /** Whether the sandbox has the file. A read failure means "no file". */
    private async exists(
        sandbox: {
            readFile(
                path: string,
                opts?: { timeoutMs?: number },
            ): Promise<string>;
        },
        path: string,
    ): Promise<boolean> {
        try {
            await sandbox.readFile(path, { timeoutMs: 10_000 });
            return true;
        } catch {
            return false;
        }
    }
}
