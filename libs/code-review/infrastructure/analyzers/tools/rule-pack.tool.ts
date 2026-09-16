import { Injectable } from '@nestjs/common';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';
import { createLogger } from '@libs/core/log/logger';

import {
    AnalyzerFinding,
    parseAnalyzerSarif,
} from '../analyzer-finding.type';
import { RulePackLoader } from '../rule-pack-loader.service';
import {
    AnalyzerTool,
    ChangedFile,
    ToolRunInput,
} from '../tool.contract';

/**
 * Analyzer binary. Overridable so a deployment can point at its own install
 * instead of relying on one being on PATH inside the sandbox.
 */
const ANALYZER_BIN = process.env.API_OPENGREP_BIN || 'opengrep';

/**
 * Scratch directory, resolved ABSOLUTE under the sandbox repo.
 *
 * The providers disagree about relative paths: LocalSandbox resolves them
 * against the repo, E2B against the sandbox home. Absolute-under-repo is the
 * only form both accept. Never a scan target — the scan is given the selected
 * files explicitly — so it cannot report on itself.
 */
const WORK_DIR = '.kodus-analyzer';
const SCAN_TIMEOUT_MS = 60_000;

/** Extensions the rule pack has rules for. */
const SUPPORTED = new Set([
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.py',
    '.rb',
    '.go',
    '.java',
    '.php',
]);

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Kody's own security rules, run over the changed files. */
@Injectable()
export class RulePackTool implements AnalyzerTool {
    readonly id = 'rule-pack' as const;
    readonly coverage = ManagedTool.RULE_PACK;

    private readonly logger = createLogger(RulePackTool.name);

    constructor(private readonly rulePackLoader: RulePackLoader) {}

    selectFiles(files: ChangedFile[]): ChangedFile[] {
        return files.filter((file) => {
            if (!file.filename || !file.patch) {
                return false;
            }
            const dot = file.filename.lastIndexOf('.');
            return (
                dot !== -1 && SUPPORTED.has(file.filename.slice(dot).toLowerCase())
            );
        });
    }

    async run({ sandbox, files }: ToolRunInput): Promise<AnalyzerFinding[]> {
        const pack = this.rulePackLoader.load();
        if (Object.keys(pack).length === 0) {
            return [];
        }

        const workDir = `${sandbox.repoDir}/${WORK_DIR}`;
        const ruleDir = `${workDir}/rules`;
        const reportPath = `${workDir}/report.sarif`;

        for (const [name, contents] of Object.entries(pack)) {
            await sandbox.writeFile(`${ruleDir}/${name}`, contents);
        }

        const targets = files.map((file) => quote(file.filename)).join(' ');

        const result = await sandbox.run(
            `cd ${quote(sandbox.repoDir)} && ${quote(ANALYZER_BIN)} scan ` +
                `--config ${quote(ruleDir)} --sarif --output ${quote(reportPath)} ` +
                `--quiet ${targets}`,
            { timeoutMs: SCAN_TIMEOUT_MS },
        );

        // A missing binary and a clean scan both produce no findings. Throwing
        // keeps them distinguishable — the caller records the failure instead
        // of reporting the change as examined and clean.
        if (
            result.exitCode === 127 ||
            /command not found/.test(result.stdout ?? '') ||
            /command not found/.test(result.stderr ?? '')
        ) {
            throw new Error('analyzer binary unavailable in the sandbox');
        }

        const report = await sandbox.readFile(reportPath);
        return parseAnalyzerSarif(report, sandbox.repoDir);
    }
}
