import { ChangedFile } from '../tool.contract';
import { WorkflowAuditTool, WorkflowLintTool } from './workflow.tools';

const file = (filename: string): ChangedFile => ({
    filename,
    patch: '@@ -0,0 +1,1 @@\n+x',
});

const sandboxWith = (stdout: string, exitCode = 0) =>
    ({
        repoDir: '/repo',
        run: jest.fn().mockResolvedValue({ stdout, stderr: '', exitCode }),
        writeFile: jest.fn(),
        readFile: jest.fn(),
    }) as never;

describe('workflow analyzer tools', () => {
    describe.each([
        ['actionlint', () => new WorkflowLintTool()],
        ['zizmor', () => new WorkflowAuditTool()],
    ])('%s file selection', (_name, make) => {
        const tool = make();

        it.each([
            '.github/workflows/ci.yml',
            '.github/workflows/release.yaml',
        ])('claims %s', (filename) => {
            expect(tool.selectFiles([file(filename)])).toHaveLength(1);
        });

        // "Never run a tool that does not apply to the changed files."
        it.each([
            'src/index.ts',
            'docs/workflows.md',
            '.github/dependabot.yml',
            'deploy/workflows/job.yml',
        ])('ignores %s', (filename) => {
            expect(tool.selectFiles([file(filename)])).toHaveLength(0);
        });
    });

    describe('WorkflowLintTool', () => {
        const tool = new WorkflowLintTool();

        it('maps actionlint JSON into findings', async () => {
            const stdout = JSON.stringify([
                {
                    message: 'shellcheck reported issue in this script',
                    filepath: '.github/workflows/ci.yml',
                    line: 12,
                    column: 30,
                    kind: 'shellcheck',
                },
            ]);

            const findings = await tool.run({
                sandbox: sandboxWith(stdout),
                files: [file('.github/workflows/ci.yml')],
            });

            expect(findings).toEqual([
                expect.objectContaining({
                    ruleId: 'actionlint/shellcheck',
                    path: '.github/workflows/ci.yml',
                    startLine: 12,
                    message: 'shellcheck reported issue in this script',
                }),
            ]);
        });

        // actionlint exits non-zero precisely when it finds something.
        it('reads findings from a non-zero exit', async () => {
            const stdout = JSON.stringify([
                {
                    message: 'undefined variable',
                    filepath: '.github/workflows/ci.yml',
                    line: 3,
                    column: 1,
                    kind: 'expression',
                },
            ]);

            const findings = await tool.run({
                sandbox: sandboxWith(stdout, 1),
                files: [file('.github/workflows/ci.yml')],
            });

            expect(findings).toHaveLength(1);
        });

        it('returns nothing for a clean workflow', async () => {
            const findings = await tool.run({
                sandbox: sandboxWith('[]'),
                files: [file('.github/workflows/ci.yml')],
            });

            expect(findings).toEqual([]);
        });

        // A missing binary must never read as "checked and clean".
        it('throws when the binary is absent', async () => {
            await expect(
                tool.run({
                    sandbox: sandboxWith('actionlint: command not found', 127),
                    files: [file('.github/workflows/ci.yml')],
                }),
            ).rejects.toThrow(/unavailable/i);
        });

        it('survives unparseable output', async () => {
            const findings = await tool.run({
                sandbox: sandboxWith('not json'),
                files: [file('.github/workflows/ci.yml')],
            });

            expect(findings).toEqual([]);
        });
    });

    describe('WorkflowAuditTool', () => {
        const tool = new WorkflowAuditTool();

        const sarif = JSON.stringify({
            runs: [
                {
                    results: [
                        {
                            ruleId: 'zizmor/dangerous-triggers',
                            level: 'error',
                            message: { text: 'use of pull_request_target' },
                            locations: [
                                {
                                    physicalLocation: {
                                        artifactLocation: {
                                            uri: '.github/workflows/ci.yml',
                                        },
                                        region: { startLine: 2, endLine: 2 },
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        it('maps zizmor SARIF into findings', async () => {
            const findings = await tool.run({
                sandbox: sandboxWith(sarif),
                files: [file('.github/workflows/ci.yml')],
            });

            expect(findings).toEqual([
                expect.objectContaining({
                    ruleId: 'zizmor/dangerous-triggers',
                    path: '.github/workflows/ci.yml',
                    startLine: 2,
                    severity: 'error',
                }),
            ]);
        });

        it('throws when the binary is absent', async () => {
            await expect(
                tool.run({
                    sandbox: sandboxWith('zizmor: command not found', 127),
                    files: [file('.github/workflows/ci.yml')],
                }),
            ).rejects.toThrow(/unavailable/i);
        });
    });
});
