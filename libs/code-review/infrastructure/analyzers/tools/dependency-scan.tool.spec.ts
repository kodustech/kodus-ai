import { ChangedFile } from '../tool.contract';
import { DependencyScanTool } from './dependency-scan.tool';

const LOCKFILE = 'package-lock.json';

/**
 * A lockfile patch that bumps lodash and leaves minimist untouched — the
 * shape that distinguishes "this PR introduced it" from "it was already there".
 */
const lockPatch = [
    '@@ -4,7 +4,7 @@',
    '   "packages": {',
    '     "node_modules/lodash": {',
    '-      "version": "4.17.21"',
    '+      "version": "4.17.11"',
    '     },',
    '     "node_modules/minimist": {',
    '       "version": "1.2.0"',
].join('\n');

const osvJson = (
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

const sandboxWith = (stdout: string, exitCode = 0) =>
    ({
        repoDir: '/repo',
        run: jest.fn().mockResolvedValue({ stdout, stderr: '', exitCode }),
        writeFile: jest.fn(),
        readFile: jest.fn(),
    }) as never;

describe('DependencyScanTool', () => {
    const tool = new DependencyScanTool();

    describe('file selection', () => {
        it.each([
            'package-lock.json',
            'yarn.lock',
            'pnpm-lock.yaml',
            'go.sum',
            'requirements.txt',
            'Gemfile.lock',
            'poetry.lock',
            'Cargo.lock',
            'composer.lock',
            'apps/web/package-lock.json',
        ])('claims the manifest %s', (filename) => {
            expect(
                tool.selectFiles([{ filename, patch: lockPatch }]),
            ).toHaveLength(1);
        });

        it.each(['src/index.ts', 'package.json.md', 'README.md'])(
            'ignores %s',
            (filename) => {
                expect(
                    tool.selectFiles([{ filename, patch: lockPatch }]),
                ).toHaveLength(0);
            },
        );
    });

    // The point of the tool: a lockfile carries the whole dependency tree, so
    // without this every review would re-report every pre-existing CVE.
    describe('reporting only what this PR changed', () => {
        it('reports a package whose version line the PR added', async () => {
            const findings = await tool.run({
                sandbox: sandboxWith(
                    osvJson([
                        { name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' },
                    ]),
                ),
                files: [{ filename: LOCKFILE, patch: lockPatch }],
            });

            expect(findings).toEqual([
                expect.objectContaining({
                    ruleId: 'osv/GHSA-aaa',
                    path: LOCKFILE,
                }),
            ]);
        });

        it('ignores a vulnerable package the PR did not touch', async () => {
            const findings = await tool.run({
                sandbox: sandboxWith(
                    osvJson([
                        { name: 'minimist', version: '1.2.0', id: 'GHSA-bbb' },
                    ]),
                ),
                files: [{ filename: LOCKFILE, patch: lockPatch }],
            });

            expect(findings).toEqual([]);
        });

        // The anchor must land on a line the diff added, or the pipeline's
        // clipping drops the finding entirely.
        it('anchors the finding to an added line', async () => {
            const [finding] = await tool.run({
                sandbox: sandboxWith(
                    osvJson([
                        { name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' },
                    ]),
                ),
                files: [{ filename: LOCKFILE, patch: lockPatch }],
            });

            // New-side line 6 is the `+ "version": "4.17.11"` line; the
            // removed line above it does not advance the new-side cursor.
            expect(finding.startLine).toBe(6);
        });
    });

    it.each([
        ['CRITICAL', 'error'],
        ['HIGH', 'error'],
        ['MODERATE', 'warning'],
        ['LOW', 'note'],
    ])('maps %s severity to %s', async (dbSeverity, expected) => {
        const [finding] = await tool.run({
            sandbox: sandboxWith(
                osvJson([
                    {
                        name: 'lodash',
                        version: '4.17.11',
                        id: 'GHSA-aaa',
                        sev: dbSeverity,
                    },
                ]),
            ),
            files: [{ filename: LOCKFILE, patch: lockPatch }],
        });

        expect(finding.severity).toBe(expected);
    });

    it('names the package and advisory in the message', async () => {
        const [finding] = await tool.run({
            sandbox: sandboxWith(
                osvJson([{ name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' }]),
            ),
            files: [{ filename: LOCKFILE, patch: lockPatch }],
        });

        expect(finding.message).toContain('lodash');
        expect(finding.message).toContain('4.17.11');
        expect(finding.message).toContain('GHSA-aaa');
    });

    describe('degradation', () => {
        it('throws when the binary is absent', async () => {
            await expect(
                tool.run({
                    sandbox: sandboxWith('osv-scanner: command not found', 127),
                    files: [{ filename: LOCKFILE, patch: lockPatch }],
                }),
            ).rejects.toThrow(/unavailable/i);
        });

        // osv-scanner exits non-zero precisely when it finds vulnerabilities.
        it('reads results from a non-zero exit', async () => {
            const findings = await tool.run({
                sandbox: sandboxWith(
                    osvJson([
                        { name: 'lodash', version: '4.17.11', id: 'GHSA-aaa' },
                    ]),
                    1,
                ),
                files: [{ filename: LOCKFILE, patch: lockPatch }],
            });

            expect(findings).toHaveLength(1);
        });

        it('survives unparseable output', async () => {
            const findings = await tool.run({
                sandbox: sandboxWith('not json'),
                files: [{ filename: LOCKFILE, patch: lockPatch }],
            });

            expect(findings).toEqual([]);
        });

        it('returns nothing when no dependency is vulnerable', async () => {
            const findings = await tool.run({
                sandbox: sandboxWith(osvJson([])),
                files: [{ filename: LOCKFILE, patch: lockPatch }],
            });

            expect(findings).toEqual([]);
        });
    });
});
