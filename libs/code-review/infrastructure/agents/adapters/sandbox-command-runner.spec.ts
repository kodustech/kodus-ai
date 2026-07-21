import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { SandboxCommandRunner } from './sandbox-command-runner';

/** RemoteCommands stub — only `exec` matters here. */
function remote(
    exec?: RemoteCommands['exec'],
): RemoteCommands {
    return {
        grep: async () => '',
        read: async () => '',
        listDir: async () => '',
        exec,
    };
}

describe('SandboxCommandRunner', () => {
    it('delegates to RemoteCommands.exec and returns its result', async () => {
        const runner = new SandboxCommandRunner(
            remote(async (command) => ({
                exitCode: command.includes('tsc') ? 2 : 0,
                stdout: 'src/x.ts(1,1): error TS0000',
                stderr: '',
            })),
        );

        const r = await runner.run('npx tsc --noEmit');

        expect(r.exitCode).toBe(2);
        expect(r.stdout).toContain('error TS0000');
    });

    it('throws (fail-open trigger) when the sandbox has no exec', async () => {
        const runner = new SandboxCommandRunner(remote(undefined));

        await expect(runner.run('npx tsc')).rejects.toThrow('no exec');
    });
});
