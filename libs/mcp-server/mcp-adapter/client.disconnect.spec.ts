import { SpecCompliantMCPClient } from './client';

describe('SpecCompliantMCPClient.disconnect', () => {
    it('stops the session cleanup timer, even if the client never connected', async () => {
        const client = new SpecCompliantMCPClient({
            clientInfo: { name: 'test', version: '1.0.0' },
            transport: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
            capabilities: {},
        } as any);

        await client.disconnect();

        expect((client as any).sessionManager.cleanupTimer).toBeUndefined();
    });
});
