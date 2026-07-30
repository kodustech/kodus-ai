// The MCP adapter (relocated from @kodus/flow to @libs/mcp-server/mcp-adapter in
// the ai-sdk migration) is pulled in transitively via the integrations service.
// Mock it so the unit test doesn't load the real adapter + its worker-thread
// logger transport.
jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
    MCPAdapter: class {},
}));

import { McpService } from '../../src/modules/mcp/mcp.service';

const AUTH_ORG = 'org-auth';
const OTHER_ORG = 'org-victim';

function buildService() {
    // Mirrors the real repository: getConnections runs findAndCount and the
    // tenant scope MUST come from the `where.organizationId` the service builds.
    const connectionRepository = {
        findAndCount: jest.fn(({ where }: any) =>
            Promise.resolve([
                [{ id: 'c1', organizationId: where.organizationId }],
                1,
            ]),
        ),
    };
    const service = new McpService(
        {} as any,
        connectionRepository as any,
        {} as any,
        {} as any,
        {} as any,
    );
    return { service, connectionRepository };
}

describe('McpService.getConnections — tenant scoping', () => {
    it('always scopes to the authenticated org, even if the query injects a different organizationId', async () => {
        const { service, connectionRepository } = buildService();

        // A malicious/buggy client smuggles organizationId into the query
        // payload. The old `where: { organizationId, ...where }` let it override
        // the auth org → cross-tenant leak. The fix puts org LAST so auth wins.
        await service.getConnections(
            { page: 1, pageSize: 50, organizationId: OTHER_ORG } as any,
            AUTH_ORG,
        );

        const where =
            connectionRepository.findAndCount.mock.calls[0][0].where;
        expect(where.organizationId).toBe(AUTH_ORG);
        expect(where.organizationId).not.toBe(OTHER_ORG);
    });

    it('still applies legitimate filters under the org scope', async () => {
        const { service, connectionRepository } = buildService();

        await service.getConnections(
            {
                page: 1,
                pageSize: 50,
                status: 'ACTIVE',
                provider: 'kodusmcp',
            } as any,
            AUTH_ORG,
        );

        const where =
            connectionRepository.findAndCount.mock.calls[0][0].where;
        expect(where).toMatchObject({
            organizationId: AUTH_ORG,
            status: 'ACTIVE',
            provider: 'kodusmcp',
        });
    });
});
