import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { buildNativeToolConfigs } from './native-tools.factory';

const warn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: (...args: unknown[]) => warn(...args),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

/**
 * The cut report (`cut`) and its log belong to answers that were actually
 * cut. An answer that fits must come back as it was, with neither.
 */
describe('conversation tools — an answer that fits is left alone', () => {
    const run = (stdout: string) => {
        const exec = jest.fn().mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
        const tools = buildNativeToolConfigs(
            async () =>
                ({
                    remoteCommands: { exec },
                    cleanup: jest.fn(),
                    type: 'local',
                }) as unknown as SandboxInstance,
        );
        return tools.find((t) => t.name === 'exec')!.execute({ command: 'ls' });
    };

    beforeEach(() => warn.mockClear());

    it('returns a short answer whole, with no cut report and no log', async () => {
        expect(await run('a.ts\nb.ts')).toEqual({
            stdout: 'a.ts\nb.ts',
            stderr: '',
            exitCode: 0,
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('returns an answer of exactly 64,000 characters whole', async () => {
        const lines = Array.from({ length: 640 }, () => 'y'.repeat(99)).join('\n');
        const exact = lines + 'y'.repeat(64_000 - lines.length);
        expect(exact).toHaveLength(64_000);

        expect(await run(exact)).toEqual({ stdout: exact, stderr: '', exitCode: 0 });
        expect(warn).not.toHaveBeenCalled();
    });

    it('reports and logs one character more', async () => {
        const lines = Array.from({ length: 640 }, () => 'y'.repeat(99)).join('\n');
        const over = lines + 'y'.repeat(64_001 - lines.length);

        const out: any = await run(over);

        expect(out.stdout).toBe(over.slice(0, 64_000));
        expect(out.cut.hiddenChars).toEqual({ stdout: 1 });
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
