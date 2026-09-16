import { ChangedFile } from '../tool.contract';
import { IacScanTool } from './iac-scan.tool';

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
                    ruleId: 'DS-0002',
                    level: 'error',
                    message: { text: 'Last USER command in Dockerfile is root' },
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: { uri: 'Dockerfile' },
                                region: { startLine: 2, endLine: 2 },
                            },
                        },
                    ],
                },
            ],
        },
    ],
});

describe('IacScanTool', () => {
    const tool = new IacScanTool();

    describe('file selection', () => {
        it.each([
            'Dockerfile',
            'Dockerfile.prod',
            'docker/Containerfile',
            'infra/main.tf',
            'infra/vars.tfvars',
            'docker-compose.yml',
            'docker-compose.prod.yaml',
            'k8s/deployment.yaml',
            'kubernetes/service.yml',
            'charts/api/templates/deploy.yaml',
            'manifests/ingress.yaml',
        ])('claims %s', (filename) => {
            expect(tool.selectFiles([file(filename)])).toHaveLength(1);
        });

        // A bare YAML is far more often config than infrastructure; claiming
        // every .yaml would run the scanner on most PRs for nothing.
        it.each([
            'src/index.ts',
            'config/app.yaml',
            '.github/workflows/ci.yml',
            'docs/deployment.md',
        ])('ignores %s', (filename) => {
            expect(tool.selectFiles([file(filename)])).toHaveLength(0);
        });
    });

    it('maps trivy SARIF into findings', async () => {
        const findings = await tool.run({
            sandbox: sandboxWith(sarif),
            files: [file('Dockerfile')],
        });

        expect(findings).toEqual([
            expect.objectContaining({
                ruleId: 'DS-0002',
                path: 'Dockerfile',
                startLine: 2,
                severity: 'error',
            }),
        ]);
    });

    it('scans only the files it was given', async () => {
        const sandbox = sandboxWith('{"runs":[{"results":[]}]}');

        await tool.run({
            sandbox,
            files: [file('Dockerfile'), file('infra/main.tf')],
        });

        const [[command]] = (sandbox as unknown as { run: jest.Mock }).run.mock
            .calls;
        expect(command).toContain("'Dockerfile'");
        expect(command).toContain("'infra/main.tf'");
    });

    // The checks bundle is baked into the image; a review must never wait on a
    // registry fetch, and must never silently scan with no checks loaded.
    it('runs with the bundled checks and no network fetch', async () => {
        const sandbox = sandboxWith('{"runs":[{"results":[]}]}');

        await tool.run({ sandbox, files: [file('Dockerfile')] });

        const [[command]] = (sandbox as unknown as { run: jest.Mock }).run.mock
            .calls;
        expect(command).toContain('--skip-check-update');
    });

    it('throws when the binary is absent', async () => {
        await expect(
            tool.run({
                sandbox: sandboxWith('trivy: command not found', 127),
                files: [file('Dockerfile')],
            }),
        ).rejects.toThrow(/unavailable/i);
    });

    it('survives unparseable output', async () => {
        const findings = await tool.run({
            sandbox: sandboxWith('not json'),
            files: [file('Dockerfile')],
        });

        expect(findings).toEqual([]);
    });
});
