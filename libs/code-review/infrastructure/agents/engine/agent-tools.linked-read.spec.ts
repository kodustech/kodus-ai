import { buildAgentTools } from './agent-tools.factory';

/**
 * readFile on a linked repository runs a read command through the sandbox's
 * exec. In E2B that is a shell, where a plain `cat` follows a symlink the
 * linked repository commits; the local sandbox runs no shell, refuses the
 * guarded command, and checks each argument's real path itself.
 */
describe('agent tools — readFile on a linked repository', () => {
    const linkedRepoAccess: any = {
        list: () => [{ repository: 'acme/shared', preferredRef: 'main' }],
        ensureCloned: async () => ({
            ok: true,
            rootPath: '/home/user/linked/acme-shared',
            repository: 'acme/shared',
        }),
    };
    const tools = (exec: jest.Mock) =>
        buildAgentTools(
            {
                grep: async () => '',
                read: async () => '',
                listDir: async () => '',
                exec,
            } as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            linkedRepoAccess,
        );

    it('reads through the guarded command in a shell sandbox', async () => {
        const exec = jest
            .fn()
            .mockResolvedValue({ stdout: 'body\n', stderr: '', exitCode: 0 });

        const out = await tools(exec).readFile.execute({
            path: 'src/a.ts',
            repo: 'acme/shared',
        });

        expect(out).toContain('body');
        // The symlink probe, then the guarded read.
        expect(exec).toHaveBeenCalledTimes(2);
        expect(exec.mock.calls[0][0]).toMatch(/^find .* -maxdepth 0 -type l$/);
        expect(exec.mock.calls[1][0]).toContain(
            'Symlink detected, refusing to follow',
        );
    });

    it('falls back to the plain read where the local sandbox refuses a shell command', async () => {
        const exec = jest.fn(async (cmd: string) =>
            cmd.startsWith('cat ')
                ? { stdout: 'body\n', stderr: '', exitCode: 0 }
                : {
                      stdout: `Unsupported shell syntax in local sandbox: ${cmd}`,
                      stderr: '',
                      exitCode: 1,
                  },
        );

        const out = await tools(exec as any).readFile.execute({
            path: 'src/a.ts',
            repo: 'acme/shared',
        });

        expect(out).toContain('body');
        expect(exec.mock.calls.at(-1)?.[0]).toBe(
            "cat '/home/user/linked/acme-shared/src/a.ts'",
        );
    });
});
