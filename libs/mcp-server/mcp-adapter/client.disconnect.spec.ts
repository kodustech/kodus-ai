import { SpecCompliantMCPClient } from './client';

describe('SpecCompliantMCPClient.disconnect', () => {
    const newClient = () =>
        new SpecCompliantMCPClient({
            clientInfo: { name: 'test', version: '1.0.0' },
            transport: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
            capabilities: {},
        } as any);

    it('resolves and leaves no session manager for a client that never connected', async () => {
        const client = newClient();

        await expect(client.disconnect()).resolves.toBeUndefined();

        expect((client as any).sessionManager).toBeUndefined();
    });

    it('resolves and leaves no session manager after a failed connect', async () => {
        const client = newClient();
        (client as any).client = {
            connect: jest.fn(async () => {
                throw new Error('connection refused');
            }),
            close: jest.fn(async () => undefined),
        };
        jest.spyOn(client as any, 'createTransport').mockReturnValue({});

        await expect(client.connect()).rejects.toThrow('connection refused');
        await expect(client.disconnect()).resolves.toBeUndefined();

        expect((client as any).sessionManager).toBeUndefined();
    });

    it('stops the session cleanup timer of a connected client on disconnect', async () => {
        const client = newClient();
        (client as any).client = {
            connect: jest.fn(async () => undefined),
            close: jest.fn(async () => undefined),
        };
        jest.spyOn(client as any, 'createTransport').mockReturnValue({});
        jest.spyOn(client, 'listRoots').mockResolvedValue({ roots: [] });
        await client.connect();
        const sessionManager = (client as any).sessionManager;
        const destroy = jest.spyOn(sessionManager, 'destroy');

        await client.disconnect();

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(sessionManager.cleanupTimer).toBeUndefined();
        expect((client as any).sessionManager).toBeUndefined();
    });
});
