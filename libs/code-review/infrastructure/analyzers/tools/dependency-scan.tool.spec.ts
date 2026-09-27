import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { ChangedFile } from '../tool.contract';
import { DependencyScanTool } from './dependency-scan.tool';

const LOCKFILE = 'package-lock.json';

/** Head lockfile: lodash at a vulnerable version, minimist untouched. */
const HEAD = [
    '{',
    '  "packages": {',
    '    "node_modules/lodash": {',
    '      "version": "4.17.11"',
    '    },',
    '    "node_modules/minimist": {',
    '      "version": "1.2.0"',
    '    }',
    '  }',
    '}',
].join('\n');

/** The change bumped lodash; minimist was already there. */
const PATCH = [
    '@@ -1,10 +1,10 @@',
    ' {',
    '   "packages": {',
    '     "node_modules/lodash": {',
    '-      "version": "4.17.21"',
    '+      "version": "4.17.11"',
    '     },',
    '     "node_modules/minimist": {',
    '       "version": "1.2.0"',
    '     }',
    '   }',
].join('\n');

const osv = (
    packages: Array<{ name: string; version: string; id: string; sev?: string }>,
) =>
    JSON.stringify({
        results: [
            {
                source: { path: `/repo/${LOCKFILE}`, type: 'lockfile' },
                packages: packages.map((p) => ({
                    package: { name: p.name, version: p.version },
                    vulnerabilities: [
                        {
                            id: p.id,
                            summary: `${p.name} is vulnerable`,
                            database_specific: { severity: p.sev ?? 'MODERATE' },
                        },
                    ],
                })),
            },
        ],
    });

type Fake = SandboxInstance & { run: jest.Mock; commands: string[] };

/**
 * `head` is the scan of the working tree, `base` the scan of the
 * reconstructed one. Both are driven off the directory in the command.
 */
const sandboxWith = (
    head: string,
    base: string,
    opts: { exitCode?: number; content?: string } = {},
): Fake => {
    const commands: string[] = [];
    return {
        repoDir: '/repo',
        commands,
        run: jest.fn(async (command: string) => {
            commands.push(command);
            if (command.includes('osv-scanner')) {
                const isBase = command.includes('kody-deps-base');
                return {
                    stdout: isBase ? base : head,
                    stderr: '',
                    exitCode: opts.exitCode ?? 0,
                };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        }),
        readFile: jest.fn(async () => opts.content ?? HEAD),
        writeFile: jest.fn(),
    } as never;
};

const file = (patch = PATCH): ChangedFile => ({ filename: LOCKFILE, patch });

describe('DependencyScanTool', () => {
    const tool = new DependencyScanTool();

    describe('file selection', () => {
        it.each([
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'go.sum',
            'requirements.txt', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock',
            'composer.lock', 'apps/web/package-lock.json',
        ])('claims the manifest %s', (filename) => {
            expect(tool.selectFiles([{ filename, patch: PATCH }])).toHaveLength(1);
        });

        it.each(['src/index.ts', 'package.json.md', 'README.md'])(
            'ignores %s',
            (filename) => {
                expect(
                    tool.selectFiles([{ filename, patch: PATCH }]),
                ).toHaveLength(0);
            },
        );
    });

    /**
     * The reason this tool compares two trees. A lockfile carries the whole
     * dependency graph, and a real bump puts most of it on added lines — name
     * proximity alone reported a median of 12 advisories per PR across 130 real
     * lockfile PRs, and up to 140.
     */
    describe('reporting only what the change introduced', () => {
        it('reports an advisory absent from the previous tree', async () => {
            const sandbox = sandboxWith(
                osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
                osv([]),
            );

            const findings = await tool.run({ sandbox, files: [file()] });

            expect(findings).toEqual([
                expect.objectContaining({ ruleId: 'osv/GHSA-aaa', path: LOCKFILE }),
            ]);
        });

        it('stays silent on an advisory the previous tree already had', async () => {
            const already = osv([
                { name: 'minimist', version: '1.2.0', id: 'GHSA-bbb' },
            ]);
            const sandbox = sandboxWith(already, already);

            await expect(
                tool.run({ sandbox, files: [file()] }),
            ).resolves.toEqual([]);
        });

        // Still a version this change chose, so it is still introduced.
        it('reports a package moved between two vulnerable versions', async () => {
            const sandbox = sandboxWith(
                osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
                osv([{ name: 'lodash', version: '4.17.15', id: 'GHSA-aaa' }]),
            );

            const findings = await tool.run({ sandbox, files: [file()] });

            expect(findings).toHaveLength(1);
        });

        it('separates the two trees, reporting only the difference', async () => {
            const sandbox = sandboxWith(
                osv([
                    { name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' },
                    { name: 'minimist', version: '1.2.0', id: 'GHSA-bbb' },
                ]),
                osv([{ name: 'minimist', version: '1.2.0', id: 'GHSA-bbb' }]),
            );

            const findings = await tool.run({ sandbox, files: [file()] });

            expect(findings.map((f) => f.ruleId)).toEqual(['osv/GHSA-aaa']);
        });
    });

    describe('the reconstructed tree', () => {
        it('rebuilds the previous lockfile and scans it separately', async () => {
            const sandbox = sandboxWith(
                osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
                osv([]),
            );

            await tool.run({ sandbox, files: [file()] });

            expect(
                sandbox.commands.some((c) => c.includes('base64 -d')),
            ).toBe(true);
            expect(
                sandbox.commands.filter((c) => c.includes('osv-scanner')),
            ).toHaveLength(2);
        });

        /**
         * A lockfile is hundreds of kilobytes. Passing one as a shell argument
         * exceeds the maximum command length and the process never starts —
         * which is how this first failed on a real repository.
         */
        it('materialises the base file in the sandbox rather than passing it', async () => {
            const sandbox = sandboxWith(
                osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
                osv([]),
            );
            (sandbox as unknown as { baseBranch?: string }).baseBranch = 'main';

            await tool.run({ sandbox, files: [file()] });

            const setup = (
                sandbox as unknown as { commands: string[] }
            ).commands.find((c) => c.includes('kody-deps-base'));
            expect(setup).toContain('git -C');
            expect(setup).toContain("origin/main:package-lock.json");
            expect(setup).not.toContain('base64 -d');
        });

        it('cleans the reconstructed tree up', async () => {
            const sandbox = sandboxWith(
                osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
                osv([]),
            );

            await tool.run({ sandbox, files: [file()] });

            expect(
                sandbox.commands.some((c) => /^rm -rf .*kody-deps-base/.test(c)),
            ).toBe(true);
        });

        /**
         * Without a baseline the only options are reporting the whole tree or
         * reporting nothing, and the whole tree is the flood this prevents.
         */
        it('reports nothing when the previous tree cannot be rebuilt', async () => {
            const sandbox = sandboxWith(
                osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
                osv([]),
                { content: 'unrelated content the patch does not fit' },
            );

            await expect(
                tool.run({ sandbox, files: [file()] }),
            ).resolves.toEqual([]);
        });

        // A manifest the change added has no previous version at all, so
        // everything it brings in is new.
        it('treats a newly added manifest as all-new', async () => {
            const added = [
                '{',
                '  "packages": {',
                '    "node_modules/lodash": { "version": "4.17.11" }',
                '  }',
                '}',
            ].join('\n');
            const sandbox = sandboxWith(
                osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
                osv([]),
                { content: added },
            );

            const findings = await tool.run({
                sandbox,
                files: [
                    {
                        filename: LOCKFILE,
                        patch: [
                            '@@ -0,0 +1,5 @@',
                            ...added.split('\n').map((l) => `+${l}`),
                        ].join('\n'),
                    },
                ],
            });

            expect(findings).toHaveLength(1);
        });
    });

    it.each([
        ['CRITICAL', 'error'],
        ['HIGH', 'error'],
        ['MODERATE', 'warning'],
        ['LOW', 'note'],
    ])('maps %s severity to %s', async (dbSeverity, expected) => {
        const sandbox = sandboxWith(
            osv([
                { name: 'lodash', version: '4.17.11', id: 'GHSA-aaa', sev: dbSeverity },
            ]),
            osv([]),
        );

        const [finding] = await tool.run({ sandbox, files: [file()] });

        expect(finding.severity).toBe(expected);
    });

    it('anchors the finding on a line the change added', async () => {
        const sandbox = sandboxWith(
            osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
            osv([]),
        );

        const [finding] = await tool.run({ sandbox, files: [file()] });

        // New-side line 4 is `+      "version": "4.17.11"`: three context
        // lines precede it, and the removed line does not advance the
        // new-side cursor.
        expect(finding.startLine).toBe(4);
    });

    it('names the package and advisory in the message', async () => {
        const sandbox = sandboxWith(
            osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
            osv([]),
        );

        const [finding] = await tool.run({ sandbox, files: [file()] });

        expect(finding.message).toContain('lodash');
        expect(finding.message).toContain('4.17.11');
        expect(finding.message).toContain('GHSA-aaa');
    });

    describe('degradation', () => {
        it('throws when the binary is absent', async () => {
            const sandbox = sandboxWith('osv-scanner: command not found', '', {
                exitCode: 127,
            });

            await expect(
                tool.run({ sandbox, files: [file()] }),
            ).rejects.toThrow(/unavailable/i);
        });

        /**
         * osv-scanner exits 1 when it finds something and the e2b provider
         * THROWS on a non-zero exit, so the command must not be allowed to
         * fail. This shipped broken: a local sandbox returns the exit code
         * instead of throwing, so no test could see it.
         */
        it('never lets a non-zero exit fail the command', async () => {
            const sandbox = sandboxWith(
                osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
                osv([]),
            );

            await tool.run({ sandbox, files: [file()] });

            for (const command of (sandbox as unknown as { commands: string[] })
                .commands.filter((c) => c.includes('osv-scanner'))) {
                expect(command).toMatch(/\|\| true\s*$/);
            }
        });

        it('survives unparseable output', async () => {
            const sandbox = sandboxWith('not json', 'not json');

            await expect(
                tool.run({ sandbox, files: [file()] }),
            ).resolves.toEqual([]);
        });

        it('returns nothing when the new tree is clean', async () => {
            const sandbox = sandboxWith(osv([]), osv([]));

            await expect(
                tool.run({ sandbox, files: [file()] }),
            ).resolves.toEqual([]);
        });
    });
});

/**
 * The failure that matters here is not "no findings" — it is the opposite.
 * If the base tree cannot be built, an EMPTY base makes every advisory
 * already in the lockfile look introduced by this pull request, and the
 * author gets blamed for the whole tree. No baseline must therefore mean no
 * findings, never "all of them".
 */
describe('an untrustworthy baseline reports nothing, not everything', () => {
    const tool = new DependencyScanTool();

    const withFailingSetup = (head: string, fail: (cmd: string) => boolean) =>
        ({
            repoDir: '/repo',
            baseBranch: 'main',
            run: jest.fn(async (command: string) => {
                if (fail(command)) {
                    return { stdout: '', stderr: '', exitCode: 1 };
                }
                if (command.includes('osv-scanner')) {
                    const isBase = command.includes('kody-deps-base');
                    // An empty base tree — the dangerous state.
                    return {
                        stdout: isBase ? osv([]) : head,
                        stderr: '',
                        exitCode: 0,
                    };
                }
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
            readFile: jest.fn(async () => HEAD),
            writeFile: jest.fn(),
        }) as never;

    const preexisting = osv([
        { name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' },
        { name: 'minimist', version: '1.2.0', id: 'GHSA-bbb' },
    ]);

    it('reports nothing when the base ref is not in the sandbox', async () => {
        const sandbox = withFailingSetup(preexisting, (c) =>
            c.includes('rev-parse'),
        );

        const findings = await tool.run({ sandbox, files: [file()] });

        expect(findings).toEqual([]);
    });

    /**
     * `cat-file -e` is an `if` CONDITION, not a failure: a miss means the
     * manifest is new in this pull request and takes the `else rm -f` branch.
     * Only a `git show` that fails after the blob was found is a real error,
     * and the `|| exit 1` is what turns it into one. Modelling the shell —
     * including whether that guard is present — is the only way this test can
     * die when the guard is deleted.
     */
    const shellSandbox = (
        head: string,
        { blobExists, showFails }: { blobExists: boolean; showFails: boolean },
    ) =>
        ({
            repoDir: '/repo',
            baseBranch: 'main',
            run: jest.fn(async (command: string) => {
                const isSetup =
                    command.includes('kody-deps-base') &&
                    !command.includes('osv-scanner');
                if (isSetup) {
                    const guarded = command.includes('|| exit 1');
                    // A missing blob is handled by `rm -f`; a failing show
                    // only aborts the chain while the guard is there.
                    const aborts = blobExists && showFails && guarded;
                    return {
                        stdout: '',
                        stderr: '',
                        exitCode: aborts ? 1 : 0,
                    };
                }
                if (command.includes('osv-scanner')) {
                    const isBase = command.includes('kody-deps-base');
                    // Nothing was materialized, so the base tree is empty.
                    return {
                        stdout: isBase ? osv([]) : head,
                        stderr: '',
                        exitCode: 0,
                    };
                }
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
            readFile: jest.fn(async () => HEAD),
            writeFile: jest.fn(),
        }) as never;

    it('reports nothing when a base file exists but cannot be read', async () => {
        const sandbox = shellSandbox(preexisting, {
            blobExists: true,
            showFails: true,
        });

        const findings = await tool.run({ sandbox, files: [file()] });

        expect(findings).toEqual([]);
    });

    it('still reports advisories for a manifest this PR added', async () => {
        // No base blob is the normal, correct case for an added manifest:
        // its advisories really are introduced here, so they must be kept.
        const sandbox = shellSandbox(preexisting, {
            blobExists: false,
            showFails: false,
        });

        const findings = await tool.run({ sandbox, files: [file()] });

        expect(findings).toHaveLength(1);
        expect(findings[0].ruleId).toContain('GHSA-aaa');
    });

    it('reports nothing when the sandbox throws instead of returning an exit code', async () => {
        const sandbox = {
            repoDir: '/repo',
            baseBranch: 'main',
            run: jest.fn(async (command: string) => {
                if (command.includes('kody-deps-base') && !command.includes('osv-scanner')) {
                    throw new Error('exit status 1');
                }
                if (command.includes('osv-scanner')) {
                    return { stdout: preexisting, stderr: '', exitCode: 0 };
                }
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
            readFile: jest.fn(async () => HEAD),
            writeFile: jest.fn(),
        } as never;

        const findings = await tool.run({ sandbox, files: [file()] });

        expect(findings).toEqual([]);
    });
});

/**
 * The `|| true` guard exists because osv-scanner exits 1 exactly when it finds
 * something and the e2b provider THROWS on a non-zero exit. Asserting the
 * string is in the command does not prove the guard works — this models the
 * shell and the provider together, so removing `|| true` turns the scan red
 * instead of leaving it green.
 */
describe('a scanner that exits non-zero on findings still returns them', () => {
    const tool = new DependencyScanTool();

    /** Throws on a non-zero exit, as e2b does — after the shell has had its say. */
    const throwingSandbox = (head: string) =>
        ({
            repoDir: '/repo',
            run: jest.fn(async (command: string) => {
                const isScan = command.includes('osv-scanner');
                // osv-scanner's real behaviour: exit 1 when it has findings.
                const rawExit = isScan ? 1 : 0;
                // `cmd || true` makes the SHELL exit 0 regardless.
                const shellExit = /\|\|\s*true\s*$/.test(command) ? 0 : rawExit;
                if (shellExit !== 0) {
                    throw new Error(`exit status ${shellExit}`);
                }
                return {
                    stdout: isScan
                        ? command.includes('kody-deps-base')
                            ? osv([])
                            : head
                        : '',
                    stderr: '',
                    exitCode: 0,
                };
            }),
            readFile: jest.fn(async () => HEAD),
            writeFile: jest.fn(),
        }) as never;

    it('survives the non-zero exit and reports the introduced advisory', async () => {
        const sandbox = throwingSandbox(
            osv([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
        );

        const findings = await tool.run({ sandbox, files: [file()] });

        expect(findings).toHaveLength(1);
        expect(findings[0].ruleId).toContain('GHSA-aaa');
    });
});
