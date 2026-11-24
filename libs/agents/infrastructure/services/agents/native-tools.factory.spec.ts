import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { NULL_SANDBOX_INSTANCE } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';

import {
    buildNativeToolConfigs,
    REPOSITORY_UNAVAILABLE,
} from './native-tools.factory';

describe('buildNativeToolConfigs', () => {
    const remoteCommands = {
        grep: jest.fn().mockResolvedValue(''),
        read: jest.fn().mockResolvedValue(''),
        listDir: jest.fn().mockResolvedValue(''),
    };
    const sandbox = {
        remoteCommands,
        cleanup: jest.fn(),
        type: 'local',
    } as unknown as SandboxInstance;
    const runOn = (open: () => Promise<SandboxInstance>) => {
        const tools = buildNativeToolConfigs(open);
        return (name: string, input: unknown) =>
            tools.find((t) => t.name === name)!.execute(input);
    };
    const run = runOn(async () => sandbox);

    beforeEach(() => jest.clearAllMocks());

    it('strips the leading slash of Azure Repos paths', async () => {
        await run('readFile', { path: '/app/main.py', start: 1, end: 2 });
        await run('listDir', { path: '/app', maxDepth: 1 });
        await run('grep', { pattern: 'total', path: '/app' });
        await run('grep', { pattern: 'total', path: '/' });
        await run('grep', { pattern: 'total' });

        expect(remoteCommands.read).toHaveBeenCalledWith('app/main.py', 1, 2);
        expect(remoteCommands.listDir).toHaveBeenCalledWith('app', 1);
        expect(remoteCommands.grep.mock.calls.map((c) => c[1])).toEqual([
            'app',
            '.',
            '.',
        ]);
    });

    it('opens the sandbox on a call, not when the tools are built', async () => {
        const open = jest.fn().mockResolvedValue(sandbox);
        const call = runOn(open);

        expect(open).not.toHaveBeenCalled();
        await call('grep', { pattern: 'total' });
        expect(open).toHaveBeenCalledTimes(1);
    });

    it.each(['grep', 'readFile', 'listDir', 'exec'])(
        'answers %s that the checkout is unavailable on a null sandbox',
        async (name) => {
            const call = runOn(async () => NULL_SANDBOX_INSTANCE);

            await expect(
                call(name, {
                    pattern: 'x',
                    path: 'a.ts',
                    start: 1,
                    end: 2,
                    command: 'git log',
                }),
            ).resolves.toEqual({ error: REPOSITORY_UNAVAILABLE });
        },
    );

    it('opens nothing for a call it refuses', async () => {
        const open = jest.fn().mockResolvedValue(sandbox);

        const out = await runOn(open)('readFile', {
            path: '.env',
            start: 1,
            end: 5,
        });

        expect((out as { error: string }).error).toContain('secret file');
        expect(open).not.toHaveBeenCalled();
    });

    it('says exec is unavailable when the checkout has none', async () => {
        await expect(run('exec', { command: 'git log' })).resolves.toEqual({
            error: 'exec is not available in this checkout.',
        });
    });
});
