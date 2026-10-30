// The MCP adapter (relocated from @kodus/flow to @libs/mcp-server/mcp-adapter in
// the ai-sdk migration) is pulled in transitively via the integrations service.
// Mock it so the unit test doesn't load the real adapter + its worker-thread
// logger transport.
jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
    MCPAdapter: class {},
}));

import { McpService } from '../../src/modules/mcp/mcp.service';

/**
 * Regression guard for the plugins UI gate (issue #1459): the web app
 * computes which connections are "runnable" under the free-plan cap by
 * taking the first N of this list (see apps/web PluginsGrid). Without a
 * deterministic ORDER BY, Postgres can return rows in any order across
 * requests, so "the first 3" silently drifted between page loads — a
 * plugin could show as locked on one refresh and unlocked on the next.
 * `createdAt ASC` pins it to oldest-first, matching the backend runtime
 * cap in libs/mcp-server's getConnections slice.
 */
describe('McpService.getConnections — deterministic ordering', () => {
    it('orders connections by createdAt ascending', async () => {
        const connectionRepository = {
            findAndCount: jest
                .fn()
                .mockResolvedValue([[{ id: 'c1' }, { id: 'c2' }], 2]),
        };
        const service = new McpService(
            {} as any,
            connectionRepository as any,
            {} as any,
            {} as any,
            {} as any,
        );

        await service.getConnections(
            { page: 1, pageSize: 50 } as any,
            'org-1',
        );

        const options = connectionRepository.findAndCount.mock.calls[0][0];
        expect(options.order).toEqual({ createdAt: 'ASC' });
    });
});
