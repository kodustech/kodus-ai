/**
 * Review on #2709 (sartorijr92, round 2): the manager now runs the cloud
 * address policy on cloud (its image is built with API_CLOUD_MODE=true like
 * api/webhooks/worker). A managed entry whose catalog URL is relative
 * (`/mcp/issues`) is resolved against the platform's own
 * API_KODUS_MCP_SERVER_URL, which is internal: that client is a first-party
 * endpoint and is dialed without the check. Every other client is judged.
 */
jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(() => ({})),
}));

import { createMCPAdapter } from '@libs/mcp-server/mcp-adapter';
import { KodusMCPProvider } from '../../src/modules/providers/kodusMCP/kodus-mcp.provider';
import { CustomClient } from '../../src/clients/custom';
import { MCPIntegrationAuthType } from '../../src/modules/integrations/enums/integration.enum';

const adapter = createMCPAdapter as unknown as jest.Mock;
const savedUrl = process.env.API_KODUS_MCP_SERVER_URL;

beforeEach(() => {
    adapter.mockClear();
    process.env.API_KODUS_MCP_SERVER_URL = 'http://kodus_api:3001/mcp';
});
afterAll(() => {
    if (savedUrl === undefined) delete process.env.API_KODUS_MCP_SERVER_URL;
    else process.env.API_KODUS_MCP_SERVER_URL = savedUrl;
});

async function managedServer(integrationId: string) {
    const provider = new KodusMCPProvider(
        {} as any,
        { resolveManagedAuthHeaders: jest.fn().mockResolvedValue({}) } as any,
    );
    await (provider as any).buildManagedClient('org-1', integrationId);
    return adapter.mock.calls.at(-1)[0].servers[0];
}

describe('which MCP clients are dialed without the address check', () => {
    it('the managed issues server, resolved from the platform env, is trusted', async () => {
        const server = await managedServer('kodus-issues-default');
        expect(server.url).toBe('http://kodus_api:3001/mcp/issues');
        expect(server.trusted).toBe(true);
    });

    it('a managed server with its own public URL is judged', async () => {
        const server = await managedServer('linear-default');
        expect(server.trusted).toBe(false);
    });

    it('a custom server an org typed is judged', () => {
        new CustomClient({
            baseUrl: 'https://mcp.example.test/mcp',
            authType: MCPIntegrationAuthType.NONE,
            protocol: 'http',
        } as any);
        expect(adapter.mock.calls.at(-1)[0].servers[0].trusted).toBe(false);
    });
});
