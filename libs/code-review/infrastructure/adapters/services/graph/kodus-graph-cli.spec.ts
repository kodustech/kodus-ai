import type { SandboxInstance, SandboxRunResult } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { KodusGraphCli } from './kodus-graph-cli';

describe('KodusGraphCli.analyzeFiles', () => {
    const makeSandbox = (): SandboxInstance => ({
        type: 'local',
        sandboxId: 'test',
        repoDir: '/tmp/sandbox-repo',
        cleanup: async () => undefined,
        remoteCommands: jest.fn() as unknown as SandboxInstance['remoteCommands'],
        run: jest.fn(),
    });

    it('shells out to kodus-graph analyze with the expected flags and exits 0', async () => {
        const sandbox = makeSandbox();
        (sandbox.run as jest.Mock).mockResolvedValue({
            exitCode: 0,
            stdout: '',
            stderr: '',
        } as SandboxRunResult);

        const cli = new KodusGraphCli();
        await expect(
            cli.analyzeFiles(sandbox, ['src/a.ts', 'src/b.ts'], {
                outPath: '/tmp/sandbox-repo/.kodus-graph/analysis.json',
                graphPath: '/tmp/sandbox-repo/.kodus-graph/baseline.json',
            }),
        ).resolves.toBeUndefined();

        const call = (sandbox.run as jest.Mock).mock.calls[0];
        const cmd = call[0] as string;
        expect(cmd).toContain('kodus-graph analyze');
        expect(cmd).toContain('--files');
        expect(cmd).toContain('src/a.ts');
        expect(cmd).toContain('src/b.ts');
        expect(cmd).toContain('--graph');
        expect(cmd).toContain('baseline.json');
        expect(cmd).toContain('--out');
        expect(cmd).toContain('analysis.json');
    });

    it('throws when graphPath is missing', async () => {
        const sandbox = makeSandbox();
        const cli = new KodusGraphCli();
        await expect(
            cli.analyzeFiles(sandbox, ['src/a.ts'], {
                outPath: '/tmp/sandbox-repo/.kodus-graph/analysis.json',
                graphPath: '',
            }),
        ).rejects.toThrow(/requires graphPath/);
    });

    it('surfaces non-zero exit codes as a thrown error', async () => {
        const sandbox = makeSandbox();
        (sandbox.run as jest.Mock).mockResolvedValue({
            exitCode: 2,
            stdout: '',
            stderr: 'diff too large',
        } as SandboxRunResult);

        const cli = new KodusGraphCli();
        await expect(
            cli.analyzeFiles(sandbox, ['src/a.ts'], {
                outPath: '/tmp/sandbox-repo/.kodus-graph/analysis.json',
                graphPath: '/tmp/sandbox-repo/.kodus-graph/baseline.json',
            }),
        ).rejects.toThrow(/analyze --files failed.*diff too large/);
    });
});
