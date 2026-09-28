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

        // One failing tool must not cost the findings of the others.
        const results = await Promise.allSettled(
            selected.map(({ tool }) =>
                tool.run({ sandbox, files: tool.selectFiles(filesFor(tool)) }),
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
                const toolId = selected[index].tool.id;
                findings.push(
                    ...result.value.map((finding) => ({
                        ...finding,
                        path: toHostPath(finding.path) ?? finding.path,
                        tool: toolId,
                    })),
                );
                return;
            }
            const toolId = selected[index].tool.id;
            failed.push(toolId);
            this.logger.warn({
                message: `Analyzer "${toolId}" failed`,
                context: this.stageName,
                error: result.reason,
                metadata: { prNumber: context.pullRequest?.number },
            });
        });

        const inDiff = this.clipToDiff(findings, changedFiles);

        // Logged even when empty, and with the count BEFORE clipping. A tool
        // that produced nothing and a tool whose findings were all clipped away
        // are different failures, and both look identical from the published
        // review — which is how a scan silently returning nothing hides.
        this.logger.log({
            message: `Analyzers produced ${findings.length} finding(s), ${inDiff.length} in diff`,
            context: this.stageName,
            metadata: {
                prNumber: context.pullRequest?.number,
                ran: selected.map(({ tool }) => tool.id),
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
