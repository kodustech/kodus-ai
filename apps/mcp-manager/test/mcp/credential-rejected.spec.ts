jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
}));

import { McpService } from '../../src/modules/mcp/mcp.service';
import { MCPConnectionStatus } from '../../src/modules/mcp/entities/mcp-connection.entity';
import { RejectedCredentialOutcome } from '../../src/modules/integrations/integration-oauth.service';

const ORG = 'org-1';
const INT = 'linear-default';
const FINGERPRINT = '0123456789abcdef';

function buildService(outcome: RejectedCredentialOutcome) {
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
        handleRejectedCredential: jest.fn().mockResolvedValue(outcome),
    };
    const service = new McpService(
        {} as any,
        connectionRepository as any,
        {} as any,
        {} as any,
        integrationOAuthService as any,
    );
    return { service, update, integrationOAuthService };
}

// The runtime lists only ACTIVE connections: a credential that is gone for
// good has to take its connection out of that list, or every review sends it
// again, and the plugin page has to show it needs reconnecting.
describe('McpService.handleRejectedKodusMcpCredential', () => {
    it.each(['grant_lost', 'token_rejected'] as const)(
        'expires the connection when the outcome is %s',
        async (outcome) => {
            const { service, update, integrationOAuthService } =
                buildService(outcome);

            expect(
                await service.handleRejectedKodusMcpCredential(
                    ORG,
                    INT,
                    FINGERPRINT,
                ),
            ).toEqual({ outcome });
            expect(
                integrationOAuthService.handleRejectedCredential,
            ).toHaveBeenCalledWith(ORG, INT, FINGERPRINT);
            expect(update.set).toHaveBeenCalledWith({
                status: MCPConnectionStatus.EXPIRED,
            });
            expect(update.where).toHaveBeenCalledWith(
                '"organizationId" = :organizationId',
                { organizationId: ORG },
            );
            expect(update.execute).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['refreshed', 'kept', 'stale'] as const)(
        'leaves the connection ACTIVE when the outcome is %s',
        async (outcome) => {
            const { service, update } = buildService(outcome);

            await service.handleRejectedKodusMcpCredential(
                ORG,
                INT,
                FINGERPRINT,
            );

            expect(update.execute).not.toHaveBeenCalled();
        },
    );
});
