import { Injectable } from '@nestjs/common';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import { AnalyzerFinding, parseAnalyzerSarif } from '../analyzer-finding.type';
import {
    AnalyzerTool,
    ChangedFile,
    ToolRunInput,
    toRepoRelativePath,
} from '../tool.contract';

const RUN_TIMEOUT_MS = 60_000;

/**
 * Files whose whole purpose is to hold credential-SHAPED placeholders.
 * Measured: betterleaks reports `postgresql://user:password@localhost` in an
 * `.env.example` as a credential URI. It is a template, not a leak, and a
 * scanner we publish from cannot cry wolf on the file that exists to be copied.
 *
 * The repository's own scanner config still applies on top of this.
 */
const PLACEHOLDER_FILE = /\.(example|sample|template|dist)(\.[^.]+)?$/i;

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Secret scanning over the changed files.
 *
 * betterleaks rather than gitleaks: gitleaks is feature-complete and receives
 * security patches only, and on our own corpus it detected 0 of 6 planted
 * credentials while betterleaks detected 6 of 6.
 */
@Injectable()
export class SecretScanTool implements AnalyzerTool {
    readonly id = 'secrets' as const;
    readonly coverage = ManagedTool.SECRETS;

    /** Any file can carry a credential, so this tool filters by intent, not language. */
    selectFiles(files: ChangedFile[]): ChangedFile[] {
        return files.filter(
            (file) =>
                file.filename &&
                file.patch &&
                !PLACEHOLDER_FILE.test(file.filename),
        );
    }

    async run({ sandbox, files }: ToolRunInput): Promise<AnalyzerFinding[]> {
        // `betterleaks dir` with no path scans the entire checkout, which
        // would reach every file the review was told to ignore. No targets
        // means nothing to scan, not "scan everything".
        if (files.length === 0) {
            return [];
        }

        const targets = files
            .map((file) => quote(toRepoRelativePath(file.filename)))
            .join(' ');

        const result = await sandbox.run(
            `cd ${quote(sandbox.repoDir)} && betterleaks dir ${targets} ` +
                `--report-format sarif --report-path - --no-banner --exit-code 0`,
            { timeoutMs: RUN_TIMEOUT_MS },
        );

        if (
            result.exitCode === 127 ||
            /command not found/.test(result.stdout ?? '') ||
            /command not found/.test(result.stderr ?? '')
        ) {
            throw new Error('betterleaks unavailable in the sandbox');
        }

        return parseAnalyzerSarif(result.stdout ?? '', sandbox.repoDir);
    }
}
