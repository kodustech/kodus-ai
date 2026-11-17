import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { buildNativeToolConfigs } from './native-tools.factory';

describe('buildNativeToolConfigs', () => {
    const remoteCommands = {
        grep: jest.fn().mockResolvedValue(''),
        read: jest.fn().mockResolvedValue(''),
        listDir: jest.fn().mockResolvedValue(''),
    };
    const tools = buildNativeToolConfigs({
        remoteCommands,
        cleanup: jest.fn(),
        type: 'local',
    } as unknown as SandboxInstance);
    const run = (name: string, input: unknown) =>
        tools.find((t) => t.name === name)!.execute(input);

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
});
