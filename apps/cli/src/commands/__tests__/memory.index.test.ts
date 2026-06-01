import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureActionMock = vi.fn();

vi.mock('../memory/capture.js', () => ({
    captureAction: captureActionMock,
}));

describe('decisions capture command', () => {
    beforeEach(() => {
        vi.resetModules();
        captureActionMock.mockReset();
    });

    it('accepts legacy --agent for backwards compatibility', async () => {
        const { decisionsCommand } = await import('../memory/index.js');

        const program = new Command();
        program.exitOverride();
        program.addCommand(decisionsCommand);

        await program.parseAsync(
            [
                'node',
                'kodus',
                'decisions',
                'capture',
                '--agent',
                'claude-compatible',
                '--event',
                'stop',
            ],
            { from: 'node' },
        );

        expect(captureActionMock).toHaveBeenCalledWith(undefined, {
            agent: 'claude-compatible',
            event: 'stop',
        });
    });
});
