import { Injectable } from '@nestjs/common';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import { AnalyzerFinding } from '../analyzer-finding.type';
import { AnalyzerTool, ChangedFile, ToolRunInput } from '../tool.contract';

const RUN_TIMEOUT_MS = 120_000;

/** Manifests and lockfiles osv-scanner understands. */
const MANIFEST = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'npm-shrinkwrap.json',
    'go.sum',
    'go.mod',
    'requirements.txt',
    'poetry.lock',
    'Pipfile.lock',
    'Gemfile.lock',
    'composer.lock',
    'Cargo.lock',
    'pom.xml',
    'gradle.lockfile',
    'pubspec.lock',
    'mix.lock',
]);

/** GHSA ratings, as they appear in `database_specific.severity`. */
const SEVERITY: Record<string, AnalyzerFinding['severity']> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MODERATE: 'warning',
    MEDIUM: 'warning',
    LOW: 'note',
};

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Added lines, each carrying the few patch lines immediately before it.
 *
 * A lockfile bump changes only the version line — the package NAME sits on an
 * unchanged context line above it. Matching the name against added lines alone
 * therefore misses the most common case, so each added line is paired with its
 * preceding context and matched against that.
 */
const CONTEXT_WINDOW = 6;

function addedLinesWithContext(patch: string | undefined): Array<{
    line: number;
    haystack: string;
}> {
    const added: Array<{ line: number; haystack: string }> = [];
    if (!patch) {
        return added;
    }

    let cursor = 0;
    const recent: string[] = [];

    for (const raw of patch.split('\n')) {
        const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            cursor = parseInt(hunk[1], 10);
            recent.length = 0;
            continue;
        }

        const text = raw.slice(1);

        if (raw.startsWith('+')) {
            added.push({
                line: cursor,
                haystack: [...recent, text].join('\n'),
            });
            cursor++;
        } else if (raw.startsWith('-')) {
            // Old side only: does not advance the new-side cursor.
        } else {
            cursor++;
        }

        recent.push(text);
        if (recent.length > CONTEXT_WINDOW) {
            recent.shift();
        }
    }

    return added;
}

/**
 * Known vulnerabilities in the dependencies this PR added or bumped.
 *
 * A lockfile carries the whole dependency tree, so a scan of it reports every
 * pre-existing CVE in the project — which on a lockfile-touching PR would bury
 * the review. The filter that makes this usable is by PACKAGE, not by line:
 * a vulnerable package is reported only when the diff added a line mentioning
 * it, which is also what gives the finding an anchor inside the diff.
 */
@Injectable()
export class DependencyScanTool implements AnalyzerTool {
    readonly id = 'dependencies' as const;
    readonly coverage = ManagedTool.DEPENDENCIES;

    selectFiles(files: ChangedFile[]): ChangedFile[] {
        return files.filter((file) => {
            if (!file.filename || !file.patch) {
                return false;
            }
            const base = file.filename.split('/').pop() ?? '';
            return MANIFEST.has(base);
        });
    }

    async run({ sandbox, files }: ToolRunInput): Promise<AnalyzerFinding[]> {
        const result = await sandbox.run(
            `cd ${quote(sandbox.repoDir)} && osv-scanner scan source ` +
                `--format json ${quote(sandbox.repoDir)}`,
            { timeoutMs: RUN_TIMEOUT_MS },
        );

        if (
            result.exitCode === 127 ||
            /command not found/.test(result.stdout ?? '') ||
            /command not found/.test(result.stderr ?? '')
        ) {
            throw new Error('osv-scanner unavailable in the sandbox');
        }

        let report: unknown;
        try {
            report = JSON.parse(result.stdout ?? '{}');
        } catch {
            return [];
        }

        // Where each manifest's added lines are, so a vulnerable package can be
        // matched to the line that introduced it.
        const addedByFile = files.map((file) => ({
            filename: file.filename,
            added: addedLinesWithContext(file.patch),
        }));

        const findings: AnalyzerFinding[] = [];

        for (const group of (report as { results?: unknown[] })?.results ?? []) {
            const packages =
                (group as { packages?: unknown[] })?.packages ?? [];

            for (const entry of packages) {
                const typed = entry as {
                    package?: { name?: string; version?: string };
                    vulnerabilities?: Array<{
                        id?: string;
                        summary?: string;
                        database_specific?: { severity?: string };
                    }>;
                };

                const name = typed.package?.name;
                const version = typed.package?.version;
                if (!name || !typed.vulnerabilities?.length) {
                    continue;
                }

                const anchor = this.findAnchor(addedByFile, name);
                if (!anchor) {
                    // Present in the tree but not touched by this PR.
                    continue;
                }

                for (const vulnerability of typed.vulnerabilities) {
                    if (!vulnerability.id) {
                        continue;
                    }
                    findings.push({
                        ruleId: `osv/${vulnerability.id}`,
                        path: anchor.filename,
                        startLine: anchor.line,
                        endLine: anchor.line,
                        severity:
                            SEVERITY[
                                (
                                    vulnerability.database_specific?.severity ??
                                    ''
                                ).toUpperCase()
                            ] ?? 'warning',
                        message:
                            `${name}@${version} is affected by ${vulnerability.id}` +
                            (vulnerability.summary
                                ? `: ${vulnerability.summary}`
                                : ''),
                    });
                }
            }
        }

        return findings;
    }

    /**
     * First added line whose own text or nearby context names the package.
     * Anchoring on an ADDED line is what lets the finding survive the
     * pipeline's diff clipping.
     */
    private findAnchor(
        addedByFile: Array<{
            filename: string;
            added: Array<{ line: number; haystack: string }>;
        }>,
        packageName: string,
    ): { filename: string; line: number } | null {
        for (const file of addedByFile) {
            for (const { line, haystack } of file.added) {
                if (haystack.includes(packageName)) {
                    return { filename: file.filename, line };
                }
            }
        }
        return null;
    }
}
