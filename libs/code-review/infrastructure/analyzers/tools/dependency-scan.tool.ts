import { Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import { AnalyzerFinding } from '../analyzer-finding.type';
import { revertPatch } from '../revert-patch';
import {
    AnalyzerTool,
    ChangedFile,
    ToolRunInput,
    toRepoRelativePath,
} from '../tool.contract';

const RUN_TIMEOUT_MS = 120_000;

/** Separates the scanner's JSON from the exit code appended after it. */
const EXIT_MARKER = '__OSV_EXIT:';

/**
 * Whether an added line names this package, as opposed to merely containing
 * its name. A plain substring test anchors `lodash` to a line adding
 * `lodash.merge`, which both reports an advisory the change never introduced
 * and points at the wrong line. A package name ends where a name character
 * stops, so require a boundary on each side — `"node_modules/lodash"` and
 * `lodash@4.17.11` still match, `lodash.merge` no longer does.
 */
const NAME_CHAR = /[A-Za-z0-9._-]/;

function mentionsPackage(haystack: string, packageName: string): boolean {
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(packageName, from);
        if (at === -1) return false;

        const before = at === 0 ? '' : haystack[at - 1];
        const after = haystack[at + packageName.length] ?? '';

        if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) {
            return true;
        }
        from = at + 1;
    }
}

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
            added.push({
                line: cursor,
                haystack: [...recent, text].join('\n'),
            });
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
    /** Lockfiles are on the default `ignorePaths`; without them this cannot fire. */
    readonly readsIgnoredFiles = true;

    selectFiles(files: ChangedFile[]): ChangedFile[] {
        return files.filter((file) => {
            if (!file.filename || !file.patch) {
                return false;
            }
            return MANIFEST.has(file.filename.split('/').pop() ?? '');
        });
    }

    async run({ sandbox, files }: ToolRunInput): Promise<AnalyzerFinding[]> {
        const manifests = files.map((file) =>
            toRepoRelativePath(file.filename),
        );

        const head = await this.scan(sandbox, sandbox.repoDir, manifests);

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

        const setup = [
            `rm -rf ${quote(baseDir)}`,
            `mkdir -p ${quote(baseDir)}`,
        ];

        // Which manifests had to fall back to the base-branch TIP, which is
        // not what this pull request forked from.
        const fromTip: string[] = [];
        let needsGit = false;

        for (const file of files) {
            const relative = toRepoRelativePath(file.filename);
            const target = `${baseDir}/${relative}`;
            const cut = target.lastIndexOf('/');

            // Rewinding the host's own patch is preferred because the host
            // computes it against the MERGE BASE: the result is the manifest
            // as this pull request found it. `origin/<base>` is the branch
            // TIP, which has moved on — a dependency someone else bumped on
            // the base after the fork then differs from head and reads as
            // "introduced here", blaming an author who never touched it.
            if (file.patch) {
                let current: string | null = null;
                try {
                    current = await sandbox.readFile(
                        `${sandbox.repoDir}/${relative}`,
                    );
                } catch {
                    current = null;
                }

                const rewound =
                    current === null ? null : revertPatch(current, file.patch);

                if (rewound !== null) {
                    // A manifest the change ADDED has no previous version;
                    // leaving it out is what makes its advisories count as new.
                    if (rewound.trim() === '') {
                        continue;
                    }
                    setup.push(`mkdir -p ${quote(target.slice(0, cut))}`);
                    setup.push(
                        `printf %s ${quote(
                            Buffer.from(rewound, 'utf8').toString('base64'),
                        )} | base64 -d > ${quote(target)}`,
                    );
                    continue;
                }
            }

            // The patch did not fit the checkout — an incremental review
            // diffs against the previous commit, not the base. The tip is
            // then the only baseline available, and it is approximate.
            if (sandbox.baseBranch) {
                needsGit = true;
                fromTip.push(file.filename);
                setup.push(`mkdir -p ${quote(target.slice(0, cut))}`);
                const ref = quote(`origin/${sandbox.baseBranch}:${relative}`);
                // A manifest this pull request ADDED has no base version, and
                // that absence is the signal that its advisories are new. A
                // manifest that exists on the base but cannot be read is a
                // different thing entirely: swallowing it would blame the
                // author for advisories that were already there. `cat-file -e`
                // separates the two, so only the second fails the run.
                setup.push(
                    `if git -C ${quote(sandbox.repoDir)} cat-file -e ${ref} 2>/dev/null; then ` +
                        `git -C ${quote(sandbox.repoDir)} show ${ref} > ${quote(target)} || exit 1; ` +
                        `else rm -f ${quote(target)}; fi`,
                );
                continue;
            }

            this.noBaseline(sandbox, files, {
                file: file.filename,
                reason: 'the patch does not fit the checkout and no base branch is available',
            });
            return null;
        }

        // Only assert the ref when something actually reads from it: a review
        // whose manifests all rewound cleanly needs no git at all.
        if (needsGit) {
            setup.splice(
                2,
                0,
                `git -C ${quote(sandbox.repoDir)} rev-parse --verify --quiet ` +
                    `${quote(`origin/${sandbox.baseBranch}^{commit}`)} > /dev/null`,
            );

            this.logger.warn({
                message:
                    'Dependency baseline fell back to the base branch tip for ' +
                    'some manifests. The tip may carry changes this pull ' +
                    'request never made, so an advisory fixed on the base ' +
                    'after the fork can read as introduced here.',
                context: DependencyScanTool.name,
                metadata: {
                    files: fromTip,
                    baseBranch: sandbox.baseBranch,
                },
            });
        }

        // The e2b provider throws on a non-zero exit where the local one
        // returns it. Both mean the same thing here — the base tree is not
        // trustworthy — and both must yield no baseline rather than a
        // half-built one.
        try {
            const result = await sandbox.run(setup.join(' && '), {
                timeoutMs: 30_000,
            });
            if (result.exitCode !== 0) {
                this.noBaseline(sandbox, files, {
                    exitCode: result.exitCode,
                    stderr: result.stderr?.slice(0, 500),
                });
                return null;
            }
        } catch (error) {
            this.noBaseline(sandbox, files, { error });
            return null;
        }

        try {
            return await this.scan(
                sandbox,
                baseDir,
                files.map((file) => toRepoRelativePath(file.filename)),
            );
        } finally {
            await sandbox.run(`rm -rf ${quote(baseDir)}`, {
                timeoutMs: 15_000,
            });
        }
    }

    /**
     * Reporting nothing and finding nothing are indistinguishable downstream,
     * so a baseline we could not build has to say so. The alternative — a
     * half-built base tree — would blame this pull request for every advisory
     * already in the lockfile, which is why the caller still returns null.
     */
    private noBaseline(
        sandbox: ToolRunInput['sandbox'],
        files: ChangedFile[],
        detail: Record<string, unknown>,
    ): void {
        this.logger.warn({
            message:
                'Could not rebuild the dependency baseline; reporting no ' +
                'dependency findings for this review.',
            context: DependencyScanTool.name,
            metadata: {
                ...detail,
                hasBaseBranch: Boolean(sandbox.baseBranch),
                baseBranch: sandbox.baseBranch,
                manifestCount: files.length,
            },
        });
    }

    private async scan(
        sandbox: ToolRunInput['sandbox'],
        dir: string,
        manifests: string[],
    ): Promise<Vulnerable[]> {
        // osv-scanner exits 1 precisely WHEN it finds something, and the e2b
        // provider throws on a non-zero exit rather than returning it. Without
        // this the tool fails on every pull request that has a finding — which
        // a local sandbox, returning the exit code instead of throwing, cannot
        // reproduce.
        // `scan source <dir>` is NOT recursive in v2, so a lockfile anywhere
        // but the repository root is never read and a monorepo silently gets
        // no findings. Naming each manifest also keeps head and base directly
        // comparable: `-r` would make head cover every lockfile in the tree
        // while the base holds only the changed ones, and the difference
        // between those two sets would read as "introduced".
        const targets = manifests
            .map((manifest) => `-L ${quote(`${dir}/${manifest}`)}`)
            .join(' ');

        // The exit code is the ONLY signal separating "clean" from "could not
        // run": osv-scanner prints `{"results":[]}` either way, so `|| true`
        // turned an unreachable advisory database into a clean bill of health.
        // Captured through a marker because the e2b provider throws on a
        // non-zero exit rather than returning it.
        const result = await sandbox.run(
            `osv-scanner scan source --format json ${targets}; echo "${EXIT_MARKER}$?"`,
            { timeoutMs: RUN_TIMEOUT_MS },
        );

        const stdout = result.stdout ?? '';
        const marker = stdout.lastIndexOf(EXIT_MARKER);
        const exitCode =
            marker === -1
                ? null
                : Number(stdout.slice(marker + EXIT_MARKER.length).trim());

        // Matched on the shell's own message rather than on 127: osv-scanner
        // also exits 127 when it cannot reach the advisory database, so the
        // code alone cannot tell a missing binary from a failed lookup. Both
        // are handled below; only the message distinguishes them.
        if (
            /command not found/.test(stdout) ||
            /command not found/.test(result.stderr ?? '')
        ) {
            throw new Error('osv-scanner unavailable in the sandbox');
        }

        // 0 = nothing found, 1 = vulnerabilities found. Anything else is the
        // scanner failing to answer, and must not be read as "clean".
        if (exitCode === null || (exitCode !== 0 && exitCode !== 1)) {
            throw new Error(
                `osv-scanner could not complete (exit ${exitCode ?? 'unknown'})`,
            );
        }

        let report: unknown;
        try {
            report = JSON.parse(
                (marker === -1 ? stdout : stdout.slice(0, marker)) || '{}',
            );
        } catch {
            return [];
        }

        const out: Vulnerable[] = [];

        for (const group of (report as { results?: unknown[] })?.results ??
            []) {
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
                severity:
                    SEVERITY[(v.severity ?? '').toUpperCase()] ?? 'warning',
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
                if (mentionsPackage(haystack, packageName)) {
                    return { filename: file.filename, line };
                }
            }
        }
        return null;
    }
}
