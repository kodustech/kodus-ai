import { JwtService } from '@nestjs/jwt';

import {
    KODUS_MCP_INTEGRATION_ID,
    MCPManagerService,
} from '../mcp-manager.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('MCPManagerService', () => {
    it('does not inject bearer auth when formatting first-party Kodus MCP connections', async () => {
        const permissionValidationService = {
            shouldLimitResources: jest.fn().mockResolvedValue(false),
        };
        const jwtService = {
            sign: jest.fn().mockReturnValue('signed-token'),
        };
        const service = new MCPManagerService(
            jwtService as unknown as JwtService,
            permissionValidationService as any,
        );

        const axiosGet = jest.fn().mockResolvedValue({
            items: [
                {
                    id: 'connection-1',
                    organizationId: 'org-123',
                    integrationId: KODUS_MCP_INTEGRATION_ID,
                    provider: 'kodus',
                    status: 'ACTIVE',
                    appName: 'kodus-code-management',
                    mcpUrl: 'https://api.kodus.io/mcp',
                    allowedTools: ['KODUS_LIST_REPOSITORIES'],
                    metadata: {
                        connection: {
                            id: 'connection-1',
                            mcpUrl: 'https://api.kodus.io/mcp',
                            status: 'ACTIVE',
                            appName: 'kodus-code-management',
                            authUrl: '',
                            allowedTools: ['KODUS_LIST_REPOSITORIES'],
                        },
                    },
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: null,
                },
            ],
        });

        (service as any).axiosMCPManagerService = {
            get: axiosGet,
        };

        const connections = await service.getConnections(
            { organizationId: 'org-123' },
            true,
        );

        expect(
            permissionValidationService.shouldLimitResources,
        ).toHaveBeenCalled();
        expect(jwtService.sign).toHaveBeenCalled();
        expect(axiosGet).toHaveBeenCalledWith(
            'mcp/connections',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer signed-token',
                }),
            }),
        );
        expect(connections).toEqual([
            expect.objectContaining({
                url: 'https://api.kodus.io/mcp',
                headers: {},
            }),
        ]);
    });
});
