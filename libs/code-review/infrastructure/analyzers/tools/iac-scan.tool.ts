import { Injectable } from '@nestjs/common';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import { AnalyzerFinding, parseAnalyzerSarif } from '../analyzer-finding.type';
import { AnalyzerTool, ChangedFile, ToolRunInput } from '../tool.contract';

const RUN_TIMEOUT_MS = 90_000;

/**
 * Infrastructure files, recognised conservatively.
 *
 * A bare `.yaml` is far more often application config than a Kubernetes
 * manifest, so plain YAML counts only under a directory that says otherwise.
 * Claiming every YAML would run the scanner on most PRs for nothing.
 */
const IAC_PATTERNS: RegExp[] = [
    /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$/,
    /\.tf$/,
    /\.tfvars$/,
    /(^|\/)docker-compose(\.[\w-]+)?\.ya?ml$/,
    /(^|\/)(k8s|kubernetes|charts|helm|manifests)\/.*\.ya?ml$/,
];

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Misconfiguration in infrastructure definitions — Dockerfiles, Terraform,
 * Kubernetes manifests, Helm charts.
 *
 * Trivy alone rather than Trivy plus Checkov: the two overlap heavily on these
 * file types, and two tools reporting the same misconfiguration is precisely
 * the duplication this feature exists to avoid.
 */
@Injectable()
export class IacScanTool implements AnalyzerTool {
    readonly id = 'iac' as const;
    readonly coverage = ManagedTool.IAC;

    selectFiles(files: ChangedFile[]): ChangedFile[] {
        return files.filter(
            (file) =>
                file.filename &&
                file.patch &&
                IAC_PATTERNS.some((pattern) => pattern.test(file.filename)),
        );
    }

    async run({ sandbox, files }: ToolRunInput): Promise<AnalyzerFinding[]> {
        const targets = files.map((file) => quote(file.filename)).join(' ');

        // `--skip-check-update` keeps the review off the network: the checks
        // bundle is baked into the image at build time. Without it every
        // review would wait on a registry fetch.
        const result = await sandbox.run(
            `cd ${quote(sandbox.repoDir)} && trivy config --format sarif ` +
                `--quiet --skip-check-update ${targets}`,
            { timeoutMs: RUN_TIMEOUT_MS },
        );

        if (
            result.exitCode === 127 ||
            /command not found/.test(result.stdout ?? '') ||
            /command not found/.test(result.stderr ?? '')
        ) {
            throw new Error('trivy unavailable in the sandbox');
        }

        return parseAnalyzerSarif(result.stdout ?? '', sandbox.repoDir);
    }
}
