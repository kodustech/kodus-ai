import { SessionManager } from './session-manager';
import { SpecCompliantMCPClient } from './client';

describe('SpecCompliantMCPClient', () => {
    const createClient = () =>
        new SpecCompliantMCPClient({
            clientInfo: { name: 'test', version: '1.0.0' },
            transport: { type: 'http' } as any,
            capabilities: {} as any,
        });

    afterEach(() => jest.restoreAllMocks());

    it('stops the session manager timer when it disconnects', async () => {
        const destroy = jest.spyOn(SessionManager.prototype, 'destroy');
        const client = createClient();
        (client as any).connected = true;
        (client as any).client = {
            close: jest.fn().mockResolvedValue(undefined),
        };

        await client.disconnect();

        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('does not leave the tool timeout timer running after a call finishes', async () => {
        jest.useFakeTimers();
        try {
            const client = createClient();
            jest.spyOn(client as any, 'callTool').mockResolvedValue({
                content: [],
            });
            const before = jest.getTimerCount();

            await (client as any).executeTool('tool', {});

            // Only the session manager's own interval may remain.
            expect(jest.getTimerCount()).toBe(before);
        } finally {
            jest.useRealTimers();
        }
    });
});
