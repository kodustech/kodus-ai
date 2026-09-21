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
