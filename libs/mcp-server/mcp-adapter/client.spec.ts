import { SpecCompliantMCPClient } from './client';

describe('SpecCompliantMCPClient timers', () => {
    const newClient = () =>
        new SpecCompliantMCPClient({
            clientInfo: { name: 'test', version: '1.0.0' },
            transport: { type: 'http', url: 'http://localhost/mcp' },
            capabilities: {},
        } as any);

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('starts no timer for a client that never connects', () => {
        newClient();

        expect(jest.getTimerCount()).toBe(0);
    });

    it('leaves no timer behind after disconnect', async () => {
        const client = newClient();
        (client as any).client = {
            connect: jest.fn(async () => undefined),
            close: jest.fn(async () => undefined),
        };
        jest.spyOn(client as any, 'createTransport').mockReturnValue({});
        jest.spyOn(client, 'listRoots').mockResolvedValue({ roots: [] });
        await client.connect();

        await client.disconnect();

        expect(jest.getTimerCount()).toBe(0);
    });

    it('clears the call timeout once a tool call settles', async () => {
        const client = newClient();
        jest.spyOn(client as any, 'callTool').mockResolvedValue({
            content: [],
        });

        await client.executeTool('ping');

        expect(jest.getTimerCount()).toBe(0);
    });
});
