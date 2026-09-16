import { Injectable } from '@nestjs/common';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import {
    AnalyzerFinding,
    parseAnalyzerSarif,
} from '../analyzer-finding.type';
import { AnalyzerTool, ChangedFile, ToolRunInput } from '../tool.contract';

const RUN_TIMEOUT_MS = 30_000;

/**
 * Only GitHub's own workflow directory. `deploy/workflows/job.yml` is somebody
 * else's YAML and neither tool understands it.
 */
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const selectWorkflows = (files: ChangedFile[]): ChangedFile[] =>
    files.filter((file) => file.filename && WORKFLOW_PATH.test(file.filename));

/** Both tools exit non-zero when they find something, so only 127 is fatal. */
const assertAvailable = (
    binary: string,
    result: { stdout?: string; stderr?: string; exitCode: number },
): void => {
    if (
        result.exitCode === 127 ||
        /command not found/.test(result.stdout ?? '') ||
        /command not found/.test(result.stderr ?? '')
    ) {
        throw new Error(`${binary} unavailable in the sandbox`);
    }
};

/**
 * actionlint — correctness of GitHub Actions workflows: bad expressions,
 * undefined outputs, shellcheck over inline `run:` scripts.
 *
 * Its findings are unambiguous in a way SAST findings are not: a workflow
 * either references an output that exists or it does not.
 */
@Injectable()
export class WorkflowLintTool implements AnalyzerTool {
    readonly id = 'actionlint' as const;
    readonly coverage = ManagedTool.WORKFLOW;

    selectFiles(files: ChangedFile[]): ChangedFile[] {
        return selectWorkflows(files);
    }

    async run({ sandbox, files }: ToolRunInput): Promise<AnalyzerFinding[]> {
        const targets = files.map((file) => quote(file.filename)).join(' ');

        const result = await sandbox.run(
            `cd ${quote(sandbox.repoDir)} && actionlint -no-color -format ` +
                `${quote('{{json .}}')} ${targets}`,
            { timeoutMs: RUN_TIMEOUT_MS },
        );
        assertAvailable('actionlint', result);

        let parsed: unknown;
        try {
            parsed = JSON.parse(result.stdout ?? '[]');
        } catch {
            return [];
        }
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .map((entry): AnalyzerFinding | null => {
                const item = entry as {
                    message?: string;
                    filepath?: string;
                    line?: number;
                    kind?: string;
                };
                if (!item.filepath || !item.line) {
                    return null;
                }
                return {
                    ruleId: `actionlint/${item.kind ?? 'unknown'}`,
                    path: item.filepath,
                    startLine: item.line,
                    endLine: item.line,
                    severity: 'warning',
                    message: (item.message ?? '').replace(/\s+/g, ' ').trim(),
                };
            })
            .filter((finding): finding is AnalyzerFinding => finding !== null);
    }
}

/**
 * zizmor — security auditing of GitHub Actions: dangerous triggers, script
 * injection through untrusted expressions, over-broad permissions, credential
 * persistence.
 *
 * Emits SARIF natively, so it reuses the shared parser.
 */
@Injectable()
export class WorkflowAuditTool implements AnalyzerTool {
    readonly id = 'zizmor' as const;
    readonly coverage = ManagedTool.WORKFLOW;

    selectFiles(files: ChangedFile[]): ChangedFile[] {
        return selectWorkflows(files);
    }

    async run({ sandbox, files }: ToolRunInput): Promise<AnalyzerFinding[]> {
        const targets = files.map((file) => quote(file.filename)).join(' ');

        const result = await sandbox.run(
            `cd ${quote(sandbox.repoDir)} && zizmor --format sarif --no-progress ${targets}`,
            { timeoutMs: RUN_TIMEOUT_MS },
        );
        assertAvailable('zizmor', result);

        return parseAnalyzerSarif(result.stdout ?? '', sandbox.repoDir);
    }
}
