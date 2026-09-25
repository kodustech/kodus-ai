import { Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import { AnalyzerFinding } from '../analyzer-finding.type';
import { revertPatch } from '../revert-patch';
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

type Vulnerable = {
    name: string;
    version: string;
    id: string;
    summary?: string;
    severity?: string;
};

/** Lines the patch adds, each carrying nearby context for anchoring. */
const CONTEXT_WINDOW = 6;

function addedLinesWithContext(
    patch: string | undefined,
): Array<{ line: number; haystack: string }> {
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
            added.push({ line: cursor, haystack: [...recent, text].join('\n') });
            cursor++;
        } else if (!raw.startsWith('-')) {
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
 * Known vulnerabilities the pull request INTRODUCES.
 *
 * A lockfile carries the whole dependency tree, so scanning the new one reports
 * every pre-existing advisory in the project. The obvious filter — report a
 * package whose name sits near an added line — does not survive a real
 * dependency update: a pnpm-lock bump touching 576 lines puts most of the tree
 * on added lines, and the scan then reports all of it. Measured over 130 real
 * lockfile PRs that produced a median of 12 findings each and a maximum of 140,
 * which is not a review.
 *
 * So the set decides what to report, and the diff only decides where to put it.
 * The previous lockfile is reconstructed from the patch, both versions are
 * scanned, and only advisories present in the new tree and absent from the old
 * are findings. A package the change moved from one vulnerable version to
 * another still counts — it is still a version this change chose.
 */
@Injectable()
export class DependencyScanTool implements AnalyzerTool {
    private readonly logger = createLogger(DependencyScanTool.name);

    readonly id = 'dependencies' as const;
    readonly coverage = ManagedTool.DEPENDENCIES;

    selectFiles(files: ChangedFile[]): ChangedFile[] {
        return files.filter((file) => {
            if (!file.filename || !file.patch) {
                return false;
            }
            return MANIFEST.has(file.filename.split('/').pop() ?? '');
        });
    }

    async run({ sandbox, files }: ToolRunInput): Promise<AnalyzerFinding[]> {
        const head = await this.scan(sandbox, sandbox.repoDir);

        // Nothing vulnerable in the new tree: no diff worth computing.
        if (head.length === 0) {
            return [];
        }

        const previous = await this.scanPrevious(sandbox, files);

        // A reconstruction we could not trust gives no baseline. Reporting the
        // whole tree instead would be the flood this exists to prevent.
        if (previous === null) {
            return [];
        }

        const before = new Set(previous.map((v) => this.key(v)));
        const introduced = head.filter((v) => !before.has(this.key(v)));

        return this.toFindings(introduced, files);
    }

    private key(v: Vulnerable): string {
        return `${v.name}@${v.version}:${v.id}`;
    }

    /** Rebuilds the lockfiles as they were, and scans that tree instead. */
    private async scanPrevious(
        sandbox: ToolRunInput['sandbox'],
        files: ChangedFile[],
    ): Promise<Vulnerable[] | null> {
        const baseDir = `/tmp/kody-deps-base-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`;

        const setup = [`rm -rf ${quote(baseDir)}`, `mkdir -p ${quote(baseDir)}`];

        for (const file of files) {
            // The base branch is fetched into the sandbox, so git holds the
            // real previous manifest. Prefer it: reconstructing a 400KB
            // lockfile from a 400-byte hunk depends on the patch's line
            // numbers matching the checkout, which an incremental review —
            // diffing against the previous commit rather than the base —
            // breaks. That failure is silent, because a manifest we cannot
            // rewind yields no baseline and therefore no findings.
            const fromGit = await this.readFromBase(sandbox, file.filename);
            if (fromGit !== null) {
                if (fromGit.trim() === '') {
                    continue;
                }
                const target = `${baseDir}/${file.filename}`;
                const cut = target.lastIndexOf('/');
                setup.push(`mkdir -p ${quote(target.slice(0, cut))}`);
                setup.push(
                    `printf %s ${quote(
                        Buffer.from(fromGit, 'utf8').toString('base64'),
                    )} | base64 -d > ${quote(target)}`,
                );
                continue;
            }

            let current: string;
            try {
                current = await sandbox.readFile(
                    `${sandbox.repoDir}/${file.filename}`,
                );
            } catch {
                return null;
            }

            const rewound = revertPatch(current, file.patch);
            if (rewound === null) {
                // Without a baseline every advisory in the tree would look
                // introduced, so this reports nothing — and would do so
                // silently if it did not say why.
                this.logger.warn({
                    message:
                        `No baseline for ${file.filename}: the base branch is ` +
                        'not in the sandbox and the patch does not fit the ' +
                        'checkout. Reporting no dependency findings.',
                    context: DependencyScanTool.name,
                    metadata: {
                        file: file.filename,
                        hasBaseBranch: Boolean(sandbox.baseBranch),
                        currentChars: current.length,
                        patchChars: (file.patch ?? '').length,
                    },
                });
                return null;
            }

            // A manifest the change ADDED has no previous version; leaving it
            // out of the base tree is what makes its advisories count as new.
            if (rewound.trim() === '') {
                continue;
            }

            const target = `${baseDir}/${file.filename}`;
            const cut = target.lastIndexOf('/');
            setup.push(`mkdir -p ${quote(target.slice(0, cut))}`);
            setup.push(
                `printf %s ${quote(
                    Buffer.from(rewound, 'utf8').toString('base64'),
                )} | base64 -d > ${quote(target)}`,
            );
        }

        const result = await sandbox.run(setup.join(' && '), {
            timeoutMs: 30_000,
        });
        if (result.exitCode !== 0) {
            return null;
        }

        try {
            return await this.scan(sandbox, baseDir);
        } finally {
            await sandbox.run(`rm -rf ${quote(baseDir)}`, { timeoutMs: 15_000 });
        }
    }

    /**
     * The manifest as it stands on the pull request's base branch, or null
     * when the sandbox has no base ref to read (the local provider does not
     * fetch one) so the caller falls back to rewinding the patch.
     */
    private async readFromBase(
        sandbox: ToolRunInput['sandbox'],
        filename: string,
    ): Promise<string | null> {
        const base = sandbox.baseBranch;
        if (!base) {
            return null;
        }

        const result = await sandbox.run(
            `cd ${quote(sandbox.repoDir)} && git show ` +
                `${quote(`origin/${base}:${filename}`)} 2>/dev/null || true`,
            { timeoutMs: 30_000 },
        );

        // Absent on the base branch means the change added it, which is a real
        // answer — an empty base tree makes everything it brings in new.
        if (result.exitCode !== 0) {
            return null;
        }
        return result.stdout ?? '';
    }

    private async scan(
        sandbox: ToolRunInput['sandbox'],
        dir: string,
    ): Promise<Vulnerable[]> {
        // osv-scanner exits 1 precisely WHEN it finds something, and the e2b
        // provider throws on a non-zero exit rather than returning it. Without
        // this the tool fails on every pull request that has a finding — which
        // a local sandbox, returning the exit code instead of throwing, cannot
        // reproduce.
        const result = await sandbox.run(
            `osv-scanner scan source --format json ${quote(dir)} || true`,
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

        const out: Vulnerable[] = [];

        for (const group of (report as { results?: unknown[] })?.results ?? []) {
            for (const entry of (group as { packages?: unknown[] })?.packages ??
                []) {
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

                for (const vulnerability of typed.vulnerabilities) {
                    if (!vulnerability.id) {
                        continue;
                    }
                    out.push({
                        name,
                        version: version ?? '',
                        id: vulnerability.id,
                        summary: vulnerability.summary,
                        severity: vulnerability.database_specific?.severity,
                    });
                }
            }
        }

        return out;
    }

    private toFindings(
        introduced: Vulnerable[],
        files: ChangedFile[],
    ): AnalyzerFinding[] {
        const addedByFile = files.map((file) => ({
            filename: file.filename,
            added: addedLinesWithContext(file.patch),
        }));

        const findings: AnalyzerFinding[] = [];

        for (const v of introduced) {
            const anchor = this.findAnchor(addedByFile, v.name);
            if (!anchor) {
                // Introduced transitively, with nothing in the diff naming it.
                continue;
            }

            findings.push({
                ruleId: `osv/${v.id}`,
                path: anchor.filename,
                startLine: anchor.line,
                endLine: anchor.line,
                severity: SEVERITY[(v.severity ?? '').toUpperCase()] ?? 'warning',
                message:
                    `${v.name}@${v.version} is affected by ${v.id}` +
                    (v.summary ? `: ${v.summary}` : ''),
            });
        }

        return findings;
    }

    /** Anchoring only — the set difference already decided what to report. */
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
