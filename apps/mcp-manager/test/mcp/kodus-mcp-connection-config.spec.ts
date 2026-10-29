jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
}));

import { McpService } from '../../src/modules/mcp/mcp.service';
import { MCPConnectionStatus } from '../../src/modules/mcp/entities/mcp-connection.entity';
import { MCPIntegrationOAuthStatus } from '../../src/modules/integrations/enums/integration.enum';

const ORG = 'org-1';
const INT = 'linear-default';

function buildService(
    headers: Record<string, string>,
    status: MCPIntegrationOAuthStatus | null,
) {
    const connectionRepository = {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const integrationOAuthService = {
        resolveManagedAuthHeaders: jest.fn().mockResolvedValue(headers),
        getOAuthStatus: jest.fn().mockResolvedValue(status),
    };
    const service = new McpService(
        {} as any,
        connectionRepository as any,
        {} as any,
        {} as any,
        integrationOAuthService as any,
    );
    return { service, connectionRepository };
}

// The runtime lists only ACTIVE connections. A connection whose OAuth grant
// was lost has to leave that list, or every review keeps failing to register
// it with `invalid_token`; connecting again sets it back to ACTIVE.
describe('McpService.getKodusMCPConnectionConfig', () => {
    it('expires the connection when its OAuth grant was lost', async () => {
        const { service, connectionRepository } = buildService(
            {},
            MCPIntegrationOAuthStatus.INACTIVE,
        );

        expect(await service.getKodusMCPConnectionConfig(ORG, INT)).toEqual({
            headers: {},
        });
        expect(connectionRepository.update).toHaveBeenCalledWith(
            { organizationId: ORG, integrationId: INT },
            { status: MCPConnectionStatus.EXPIRED },
        );
    });

    it('leaves a connection with usable credentials alone', async () => {
        const { service, connectionRepository } = buildService(
            { Authorization: 'Bearer ok' },
            MCPIntegrationOAuthStatus.ACTIVE,
        );

        await service.getKodusMCPConnectionConfig(ORG, INT);
        expect(connectionRepository.update).not.toHaveBeenCalled();
    });

    it('leaves a server that needs no auth alone', async () => {
        const { service, connectionRepository } = buildService({}, null);

        await service.getKodusMCPConnectionConfig(ORG, INT);
        expect(connectionRepository.update).not.toHaveBeenCalled();
    });
});
