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
    const update = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const connectionRepository = {
        createQueryBuilder: jest.fn(() => ({ update: () => update })),
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
    return { service, update };
}

// The runtime lists only ACTIVE connections. A connection whose OAuth grant
// was lost has to leave that list, or every review keeps failing to register
// it with `invalid_token`; connecting again sets it back to ACTIVE.
describe('McpService.getKodusMCPConnectionConfig', () => {
    it('expires the connection when its OAuth grant was lost', async () => {
        const { service, update } = buildService(
            {},
            MCPIntegrationOAuthStatus.INACTIVE,
        );

        expect(await service.getKodusMCPConnectionConfig(ORG, INT)).toEqual({
            headers: {},
        });
        expect(update.set).toHaveBeenCalledWith({
            status: MCPConnectionStatus.EXPIRED,
        });
        expect(update.execute).toHaveBeenCalledTimes(1);
    });

    // A reconnect can save an ACTIVE grant between the status read and the
    // update. The update is conditioned on the grant still being INACTIVE in
    // the same statement (checked against Postgres for #2314), so it cannot
    // overwrite the reconnected connection.
    it('expires only while the grant is still inactive, in the same statement', async () => {
        const { service, update } = buildService(
            {},
            MCPIntegrationOAuthStatus.INACTIVE,
        );

        await service.getKodusMCPConnectionConfig(ORG, INT);

        const [guard, params] = update.andWhere.mock.calls.find(([sql]) =>
            String(sql).includes('EXISTS'),
        );
        expect(guard).toContain('"mcp_integration_oauth"');
        expect(guard).toContain('o."status" = :inactive');
        expect(params).toEqual({
            inactive: MCPIntegrationOAuthStatus.INACTIVE,
        });
    });

    it('leaves a connection with usable credentials alone', async () => {
        const { service, update } = buildService(
            { Authorization: 'Bearer ok' },
            MCPIntegrationOAuthStatus.ACTIVE,
        );

        await service.getKodusMCPConnectionConfig(ORG, INT);
        expect(update.execute).not.toHaveBeenCalled();
    });

    it('leaves a server that needs no auth alone', async () => {
        const { service, update } = buildService({}, null);

        await service.getKodusMCPConnectionConfig(ORG, INT);
        expect(update.execute).not.toHaveBeenCalled();
    });
});
