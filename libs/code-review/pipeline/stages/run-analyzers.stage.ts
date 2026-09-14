import { Injectable } from '@nestjs/common';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';
import {
    AnalyzerFinding,
    addedLinesFromPatch,
    parseAnalyzerSarif,
} from '@libs/code-review/infrastructure/analyzers/analyzer-finding.type';
import { DeterministicEvidenceGate } from '@libs/code-review/infrastructure/analyzers/deterministic-evidence.gate';
import { RulePackLoader } from '@libs/code-review/infrastructure/analyzers/rule-pack-loader.service';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { createLogger } from '@libs/core/log/logger';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Scratch directory, resolved ABSOLUTE under the sandbox repo.
 *
 * The two providers disagree about relative paths: LocalSandbox resolves them
 * against the repo, E2B against the sandbox home. Absolute-under-repo is the
 * only form both accept — LocalSandbox permits it explicitly, and E2B has
 * nothing to resolve. The directory is never a scan target (the scan is given
 * the changed files explicitly), so it cannot report on itself.
 */
const WORK_DIR = '.kodus-analyzer';
/**
 * Analyzer binary. Overridable so a self-hosted deployment can point at its
 * own install instead of requiring one on PATH inside the sandbox.
 */
const ANALYZER_BIN = process.env.API_OPENGREP_BIN || 'opengrep';
const SCAN_TIMEOUT_MS = 60_000;

/** Shell-quote a single argument. */
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Runs Kody's own security rule pack over the changed files.
 *
 * Deterministic by design: the pack runs on every review that opts in rather
 * than when an agent decides to ask, because "did this PR introduce a known
 * vulnerability class" is not a judgement call. Findings are clipped to lines
 * the PR actually added — without that clip, a single pre-existing issue is
 * re-reported on every review of the file.
 */
@Injectable()
export class RunAnalyzersStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'RunAnalyzersStage';
    readonly label = 'Running Security Rules';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(RunAnalyzersStage.name);

    constructor(
        private readonly rulePackLoader: RulePackLoader,
        private readonly gate: DeterministicEvidenceGate,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const mode = context.codeReviewConfig?.deterministicEvidence?.rulePack;

        // One line saying why the pass did or did not run. Without it a silent
        // early return is indistinguishable from a clean scan in the logs.
        this.logger.log({
            message: `Rule pack gate: mode=${mode ?? 'unset'}`,
            context: this.stageName,
            metadata: {
                mode: mode ?? null,
                hasSandbox: Boolean(context.sandboxHandle),
                changedFiles: context.changedFiles?.length ?? 0,
                filesWithPatch: (context.changedFiles ?? []).filter(
                    (f) => f.filename && f.patch,
                ).length,
                rulePackFiles: Object.keys(this.rulePackLoader.load()).length,
            },
        });

        if (mode !== 'on' && mode !== 'auto') {
            return context;
        }

        if (!(await this.gate.isEnabled(context.organizationAndTeamData))) {
            this.logger.log({
                message: 'Rule pack skipped — deterministic evidence is in beta',
                context: this.stageName,
            });
            return context;
        }

        // `auto` defers to the customer's own pipeline; `on` is an explicit
        // instruction and runs regardless.
        if (mode === 'auto' && context.ciCoveredTools?.includes(ManagedTool.RULE_PACK)) {
            this.logger.log({
                message: 'Skipping rule pack — customer CI already runs an equivalent',
                context: this.stageName,
            });
            return context;
        }

        const sandbox = context.sandboxHandle;
        if (!sandbox) {
            return context;
        }

        const changedFiles = (context.changedFiles ?? []).filter(
            (file) => file.filename && file.patch,
        );
        if (changedFiles.length === 0) {
            return context;
        }

        const pack = this.rulePackLoader.load();
        if (Object.keys(pack).length === 0) {
            return context;
        }

        try {
            const workDir = `${sandbox.repoDir}/${WORK_DIR}`;
            const ruleDir = `${workDir}/rules`;
            const reportPath = `${workDir}/report.sarif`;

            for (const [name, contents] of Object.entries(pack)) {
                await sandbox.writeFile(`${ruleDir}/${name}`, contents);
            }

            const targets = changedFiles
                .map((file) => quote(file.filename))
                .join(' ');

            const result = await sandbox.run(
                `cd ${quote(sandbox.repoDir)} && ${quote(ANALYZER_BIN)} scan --config ${quote(ruleDir)} ` +
                    `--sarif --output ${quote(reportPath)} --quiet ${targets}`,
                { timeoutMs: SCAN_TIMEOUT_MS },
            );

            // A missing binary and a clean scan both produce no findings. They
            // must not be reported the same way, or we manufacture confidence
            // in code that was never examined.
            if (
                result.exitCode === 127 ||
                /command not found/.test(result.stdout ?? '') ||
                /command not found/.test(result.stderr ?? '')
            ) {
                this.logger.warn({
                    message: 'Analyzer binary unavailable in the sandbox',
                    context: this.stageName,
                });
                return this.updateContext(context, (draft) => {
                    draft.analyzerSkipped = 'unavailable';
                });
            }

            const report = await sandbox.readFile(reportPath);
            const findings = this.clipToDiff(
                parseAnalyzerSarif(report, sandbox.repoDir),
                changedFiles,
            );

            if (findings.length === 0) {
                return context;
            }

            this.logger.log({
                message: `Rule pack reported ${findings.length} in-diff finding(s)`,
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest?.number,
                    rules: [...new Set(findings.map((f) => f.ruleId))],
                },
            });

            return this.updateContext(context, (draft) => {
                draft.analyzerFindings = findings;
            });
        } catch (error) {
            this.logger.warn({
                message: 'Security rule pass failed',
                context: this.stageName,
                error,
                metadata: { prNumber: context.pullRequest?.number },
            });
            return context;
        }
    }

    private clipToDiff(
        findings: AnalyzerFinding[],
        changedFiles: Array<{ filename: string; patch?: string }>,
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
