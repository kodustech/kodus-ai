import { Inject, Injectable } from '@nestjs/common';

import {
    AnalyzerFinding,
    addedLinesFromPatch,
} from '@libs/code-review/infrastructure/analyzers/analyzer-finding.type';
import { AnalyzerToolRouter } from '@libs/code-review/infrastructure/analyzers/analyzer-tool.router';
import { DeterministicEvidenceGate } from '@libs/code-review/infrastructure/analyzers/deterministic-evidence.gate';
import {
    ANALYZER_TOOLS_TOKEN,
    AnalyzerTool,
    ChangedFile,
    RouteDecision,
    toRepoRelativePath,
} from '@libs/code-review/infrastructure/analyzers/tool.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { createLogger } from '@libs/core/log/logger';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Runs the deterministic tools that apply to this change.
 *
 * The router decides what applies; this stage owns the parts that are the
 * same for every tool — the release gate, diff clipping, and recording what
 * ran. Findings are clipped to lines the PR actually added, because without
 * that a pre-existing issue is re-reported on every review of the file.
 */
@Injectable()
export class RunAnalyzersStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'RunAnalyzersStage';
    readonly label = 'Running Deterministic Checks';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(RunAnalyzersStage.name);

    constructor(
        private readonly router: AnalyzerToolRouter,
        private readonly gate: DeterministicEvidenceGate,
        private readonly codeManagementService: CodeManagementService,
        @Inject(ANALYZER_TOOLS_TOKEN)
        private readonly tools: AnalyzerTool[],
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!(await this.gate.isEnabled(context.organizationAndTeamData))) {
            return context;
        }

        const sandbox = context.sandboxHandle;

        const reviewedFiles = (context.changedFiles ?? []) as ChangedFile[];
        const ignoredFiles = (context.ignoredFileChanges ??
            []) as ChangedFile[];

        // `ignorePaths` means "do not comment on this file", and that has to
        // hold for the analyzers too. Only a tool that declares
        // `readsIgnoredFiles` sees them — the dependency scan, because
        // lockfiles are on that list by default and are the only place an
        // advisory can be found. Handing them to every tool published secrets
        // from paths the customer had excluded.
        const filesFor = (tool: AnalyzerTool): ChangedFile[] =>
            tool.readsIgnoredFiles
                ? [...reviewedFiles, ...ignoredFiles]
                : reviewedFiles;

        // Routing still considers everything, so a tool is not recorded as
        // `no-matching-files` when its only matches are ignored files that it
        // is allowed to read.
        const changedFiles = [...reviewedFiles, ...ignoredFiles];

        // Before routing, because routing itself calls `selectFiles`: a tool
        // that requires a patch is dropped as `no-matching-files` on the very
        // files whose diff the host withheld, which are the ones this
        // recovery exists for. Recovering later would be too late for
        // everything except the one tool that does not filter on `patch`.
        // Skipped when nothing can use the result: with no sandbox, or with
        // every tool off (the shipped default), the recovered hunks are read
        // by no one and the raw diff is a wasted round trip on every review
        // that happens to contain a file the host withheld a patch for.
        const modes = context.codeReviewConfig?.deterministicEvidence?.tools;
        const anyToolEnabled = this.tools.some(
            (tool) => modes?.[tool.id] === true,
        );

        if (sandbox && anyToolEnabled) {
            await this.backfillMissingPatches(context, changedFiles);
        }

        const decisions = this.router.route(this.tools, {
            changedFiles,
            modes: context.codeReviewConfig?.deterministicEvidence?.tools,
            ciCoveredTools: context.ciCoveredTools,
        });

        this.logger.log({
            message: 'Analyzer routing decided',
            context: this.stageName,
            metadata: {
                prNumber: context.pullRequest?.number,
                hasSandbox: Boolean(sandbox),
                decisions,
            },
        });

        // Pair by position rather than by id: the router maps 1:1 over the
        // registry, so the tool is already known and no lookup can mismatch.
        const selected = this.tools
            .map((tool, index) => ({ tool, decision: decisions[index] }))
            .filter(({ decision }) => decision.run);

        if (selected.length === 0 || !sandbox) {
            return this.storeRouting(context, decisions);
        }

        // Routing ran against reviewed + ignored files, but a tool that may
        // not read the ignored ones can end up selecting nothing. Launching
        // it anyway is worse than skipping it: given no targets a scanner
        // falls back to the whole checkout.
        const selectedFiles = new Map(
            selected
                .map(
                    ({ tool }) =>
                        [tool, tool.selectFiles(filesFor(tool))] as const,
                )
                .filter(([, files]) => files.length > 0),
        );

        const ran = selected.filter(({ tool }) => selectedFiles.has(tool));
        if (ran.length === 0) {
            return this.storeRouting(context, decisions);
        }

        // One failing tool must not cost the findings of the others.
        const results = await Promise.allSettled(
            ran.map(({ tool }) =>
                tool.run({ sandbox, files: selectedFiles.get(tool) ?? [] }),
            ),
        );

        const findings: AnalyzerFinding[] = [];
        const failed: string[] = [];

        // A scanner reports the path it was given on disk, which is always
        // repository-relative. Azure Repos spells its changed files with a
        // leading slash, so a finding would no longer match the file it came
        // from and would be clipped as "outside the diff". Map each finding
        // back to the host's own spelling.
        const byRepoRelative = new Map(
            changedFiles
                .filter((file) => file.filename)
                .map((file) => [
                    toRepoRelativePath(file.filename),
                    file.filename,
                ]),
        );
        const toHostPath = (filename?: string): string | undefined =>
            filename === undefined
                ? filename
                : (byRepoRelative.get(toRepoRelativePath(filename)) ??
                  filename);

        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                // Tagged here because only the stage knows which tool ran
                // which position; the tools never see each other.
                const toolId = ran[index].tool.id;
                findings.push(
                    ...result.value.map((finding) => ({
                        ...finding,
                        path: toHostPath(finding.path) ?? finding.path,
                        tool: toolId,
                    })),
                );
                return;
            }
            const toolId = ran[index].tool.id;
            failed.push(toolId);
            this.logger.warn({
                message: `Analyzer "${toolId}" failed`,
                context: this.stageName,
                error: result.reason,
                metadata: { prNumber: context.pullRequest?.number },
            });
        });

        // Clipped against the files the tools were actually handed. Using
        // the stage's whole list would let a finding from an ignored path
        // through on its own added lines — the very files withheld above.
        const inDiff = this.clipToDiff(findings, [
            ...new Set([...selectedFiles.values()].flat()),
        ]);

        // Logged even when empty, and with the count BEFORE clipping. A tool
        // that produced nothing and a tool whose findings were all clipped away
        // are different failures, and both look identical from the published
        // review — which is how a scan silently returning nothing hides.
        this.logger.log({
            message: `Analyzers produced ${findings.length} finding(s), ${inDiff.length} in diff`,
            context: this.stageName,
            metadata: {
                prNumber: context.pullRequest?.number,
                ran: ran.map(({ tool }) => tool.id),
                failed,
                raw: findings.length,
                inDiff: inDiff.length,
                clippedOut: findings.length - inDiff.length,
                rules: [...new Set(inDiff.map((f) => f.ruleId))],
            },
        });

        return this.updateContext(context, (draft) => {
            draft.analyzerRouting = decisions;
            if (inDiff.length > 0) {
                draft.analyzerFindings = inDiff;
            }
            if (failed.length > 0) {
                draft.analyzerFailures = failed;
            }
        });
    }

    private storeRouting(
        context: CodeReviewPipelineContext,
        decisions: RouteDecision[],
    ): CodeReviewPipelineContext {
        return this.updateContext(context, (draft) => {
            draft.analyzerRouting = decisions;
        });
    }

    /**
     * Fills in hunks the host withheld.
     *
     * GitHub drops `patch` once a file's diff passes a size limit, and a
     * lockfile bump passes it routinely — so the change most likely to
     * introduce an advisory arrived with no diff to anchor a finding to, and
     * the finding was dropped as "outside the diff". One raw-diff request
     * recovers every missing hunk at once, so this costs a single call and
     * only when something is actually missing.
     */
    private async backfillMissingPatches(
        context: CodeReviewPipelineContext,
        files: ChangedFile[],
    ): Promise<void> {
        const missing = [
            ...new Set(
                files
                    .filter((file) => file.filename && !file.patch)
                    .map((file) => file.filename),
            ),
        ];

        const prNumber = context.pullRequest?.number;
        if (!missing.length || !prNumber || !context.repository?.name) {
            return;
        }

        const recovered = await this.codeManagementService.getFilePatches({
            organizationAndTeamData: context.organizationAndTeamData,
            repository: context.repository,
            prNumber,
            paths: missing,
        });

        const byPath = new Map(recovered.map((r) => [r.path, r.patch]));

        for (const file of files) {
            const patch = byPath.get(file.filename);
            if (!file.patch && patch) {
                file.patch = patch;
            }
        }

        this.logger.log({
            message: `Recovered ${byPath.size} of ${missing.length} missing file patch(es)`,
            context: this.stageName,
            metadata: {
                organizationId: context.organizationAndTeamData?.organizationId,
                prNumber,
                requested: missing,
                recovered: [...byPath.keys()],
            },
        });
    }

    private clipToDiff(
        findings: AnalyzerFinding[],
        changedFiles: ChangedFile[],
    ): AnalyzerFinding[] {
        const addedByFile = new Map(
            changedFiles.map((file) => [
                file.filename,
                addedLinesFromPatch(file.patch),
            ]),
        );

        return findings.filter((finding) =>
            addedByFile.get(finding.path)?.has(finding.startLine),
        );
    }
}
