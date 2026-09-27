import { ChangedFile } from '../tool.contract';
import { SecretScanTool } from './secret-scan.tool';

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

const sarif = JSON.stringify({
    runs: [
        {
            results: [
                {
                    ruleId: 'github-pat',
                    level: 'error',
                    message: { text: 'GitHub personal access token' },
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: {
                                    uri: '/repo/scripts/publish.js',
                                },
                                region: { startLine: 4, endLine: 4 },
                            },
                        },
                    ],
                },
            ],
        },
    ],
});

describe('SecretScanTool', () => {
    const tool = new SecretScanTool();

    describe('file selection', () => {
        // A credential can land in any file type, so this tool is the one that
        // does not filter by language.
        it.each([
            'src/index.ts',
            'config/signing-key.pem',
            'README.md',
            'deploy/values.yaml',
        ])('claims %s', (filename) => {
            expect(tool.selectFiles([file(filename)])).toHaveLength(1);
        });

        // Measured false positive: betterleaks flags the placeholder
        // `postgresql://user:password@localhost` in an .env.example.
        it.each([
            '.env.example',
            '.env.sample',
            'config/settings.template.json',
            'docker-compose.override.dist.yml',
        ])('ignores the placeholder file %s', (filename) => {
            expect(tool.selectFiles([file(filename)])).toHaveLength(0);
        });

        it('ignores a file with no patch', () => {
            expect(tool.selectFiles([{ filename: 'src/a.ts' }])).toHaveLength(0);
        });
    });

    it('maps findings out of SARIF, relative to the repo', async () => {
        const findings = await tool.run({
            sandbox: sandboxWith(sarif),
            files: [file('scripts/publish.js')],
        });

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: 'github-pat',
                path: 'scripts/publish.js',
                startLine: 4,
            }),
        ]);
    });

    it('returns nothing when the scan is clean', async () => {
        const findings = await tool.run({
            sandbox: sandboxWith('{"runs":[{"results":[]}]}'),
            files: [file('src/index.ts')],
        });

        expect(findings).toEqual([]);
    });

    // A missing binary must never read as "scanned and clean".
    it('throws when the binary is absent', async () => {
        await expect(
            tool.run({
                sandbox: sandboxWith('betterleaks: command not found', 127),
                files: [file('src/index.ts')],
            }),
        ).rejects.toThrow(/unavailable/i);
    });

    // A non-zero exit is how the scanner reports finding something.
    it('reads findings from a non-zero exit', async () => {
        const findings = await tool.run({
            sandbox: sandboxWith(sarif, 1),
            files: [file('scripts/publish.js')],
        });

        expect(findings).toHaveLength(1);
    });

    it('scans only the files it was given', async () => {
        const sandbox = sandboxWith('{"runs":[{"results":[]}]}');

        await tool.run({
            sandbox,
            files: [file('src/a.ts'), file('src/b.ts')],
        });

        const [[command]] = (sandbox as unknown as { run: jest.Mock }).run.mock
            .calls;
        expect(command).toContain("'src/a.ts'");
        expect(command).toContain("'src/b.ts'");
    });
});

describe('host path normalization', () => {
    it('strips the leading slash Azure Repos puts on changed-file paths', async () => {
        const commands: string[] = [];
        const sandbox = {
            repoDir: '/home/user/repo',
            run: async (cmd: string) => {
                commands.push(cmd);
                return { exitCode: 0, stdout: '{"runs":[]}', stderr: '' };
            },
        };

        await new SecretScanTool().run({
            sandbox: sandbox as never,
            files: [
                { filename: '/src/e2e/config.ts', patch: '@@ -0,0 +1 @@\n+x' },
            ] as never,
        });

        expect(commands[0]).toContain("'src/e2e/config.ts'");
        expect(commands[0]).not.toContain("'/src/e2e/config.ts'");
    });
});
