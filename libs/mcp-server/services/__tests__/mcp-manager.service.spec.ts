import { JwtService } from '@nestjs/jwt';

import {
    KODUS_MCP_INTEGRATION_ID,
    MCPManagerService,
} from '../mcp-manager.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('MCPManagerService', () => {
    it('signs an organization-bound credential only for the configured Kodus MCP endpoint', async () => {
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

        const previousUrl = process.env.API_KODUS_MCP_SERVER_URL;
        const previousSecret = process.env.API_JWT_SECRET;
        process.env.API_KODUS_MCP_SERVER_URL = 'https://api.kodus.io/mcp';
        process.env.API_JWT_SECRET = 'test-secret';
        let connections;
        try {
            connections = await service.getConnections(
                { organizationId: 'org-123' },
                true,
            );
        } finally {
            if (previousUrl === undefined)
                delete process.env.API_KODUS_MCP_SERVER_URL;
            else process.env.API_KODUS_MCP_SERVER_URL = previousUrl;
            if (previousSecret === undefined) delete process.env.API_JWT_SECRET;
            else process.env.API_JWT_SECRET = previousSecret;
        }

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
        expect(jwtService.sign).toHaveBeenCalledWith(
            { organizationId: 'org-123' },
            expect.objectContaining({
                audience: 'kodus-mcp-server',
                issuer: 'kodus-mcp-server',
                expiresIn: '1h',
            }),
        );
        expect(connections).toEqual([
            expect.objectContaining({
                url: 'https://api.kodus.io/mcp',
                headers: { Authorization: 'Bearer signed-token' },
            }),
        ]);
    });

    it('injects the resolved auth header for kodusmcp OAuth/token connections', async () => {
        const permissionValidationService = {
            shouldLimitResources: jest.fn().mockResolvedValue(false),
        };
        const jwtService = { sign: jest.fn().mockReturnValue('signed-token') };
        const service = new MCPManagerService(
            jwtService as unknown as JwtService,
            permissionValidationService as any,
        );

        const axiosGet = jest.fn().mockImplementation((path: string) => {
            if (path === 'mcp/connections') {
                return Promise.resolve({
                    items: [
                        {
                            id: 'connection-1',
                            organizationId: 'org-123',
                            integrationId: 'linear-default',
                            provider: 'kodusmcp',
                            status: 'ACTIVE',
                            appName: 'Linear',
                            mcpUrl: 'https://mcp.linear.app/mcp',
                            allowedTools: ['list_issues'],
                            metadata: {},
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            deletedAt: null,
                        },
                    ],
                });
            }
            if (
                path ===
                'mcp/integration/kodusmcp/linear-default/connection-config'
            ) {
                return Promise.resolve({
                    headers: { Authorization: 'Bearer resolved-token' },
                });
            }
            return Promise.resolve(undefined);
        });

        (service as any).axiosMCPManagerService = { get: axiosGet };

        const connections = await service.getConnections(
            { organizationId: 'org-123' },
            true,
        );

        expect(axiosGet).toHaveBeenCalledWith(
            'mcp/integration/kodusmcp/linear-default/connection-config',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer signed-token',
                }),
            }),
        );
        expect(connections).toEqual([
            expect.objectContaining({
                url: 'https://mcp.linear.app/mcp',
                headers: { Authorization: 'Bearer resolved-token' },
            }),
        ]);
    });

    it('keeps kodusmcp connections working (empty headers) when config resolution fails', async () => {
        const permissionValidationService = {
            shouldLimitResources: jest.fn().mockResolvedValue(false),
        };
        const jwtService = { sign: jest.fn().mockReturnValue('signed-token') };
        const service = new MCPManagerService(
            jwtService as unknown as JwtService,
            permissionValidationService as any,
        );

        const axiosGet = jest.fn().mockImplementation((path: string) => {
            if (path === 'mcp/connections') {
                return Promise.resolve({
                    items: [
                        {
                            id: 'connection-2',
                            organizationId: 'org-123',
                            integrationId: 'context7-default',
                            provider: 'kodusmcp',
                            status: 'ACTIVE',
                            appName: 'Context7',
                            mcpUrl: 'https://context7.example/mcp',
                            allowedTools: [],
                            metadata: {},
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            deletedAt: null,
                        },
                    ],
                });
            }
            return Promise.reject(new Error('connection-config unavailable'));
        });

        (service as any).axiosMCPManagerService = { get: axiosGet };

        const connections = await service.getConnections(
            { organizationId: 'org-123' },
            true,
        );

        expect(connections).toEqual([
            expect.objectContaining({
                url: 'https://context7.example/mcp',
                headers: {},
            }),
        ]);
    });
});

describe('Kodus MCP credential destination', () => {
    const sign = jest.fn().mockReturnValue('signed-token');
    const service = new MCPManagerService(
        { sign } as any,
        {} as any,
        {} as any,
    );
    const connection = {
        integrationId: KODUS_MCP_INTEGRATION_ID,
        provider: 'kodus',
        organizationId: 'org-1',
        mcpUrl: 'https://api.kodus.io/mcp',
    };
    let previousUrl: string | undefined;
    let previousSecret: string | undefined;

    beforeEach(() => {
        jest.clearAllMocks();
        previousUrl = process.env.API_KODUS_MCP_SERVER_URL;
        previousSecret = process.env.API_JWT_SECRET;
        process.env.API_KODUS_MCP_SERVER_URL = connection.mcpUrl;
        process.env.API_JWT_SECRET = 'test-secret';
    });
    afterEach(() => {
        if (previousUrl === undefined)
            delete process.env.API_KODUS_MCP_SERVER_URL;
        else process.env.API_KODUS_MCP_SERVER_URL = previousUrl;
        if (previousSecret === undefined) delete process.env.API_JWT_SECRET;
        else process.env.API_JWT_SECRET = previousSecret;
    });

    it('never sends the service credential to another endpoint', async () => {
        const result = await (service as any).formatConnection(
            { ...connection, mcpUrl: 'https://other.example/mcp' },
            'org-1',
        );
        expect(result.headers).toEqual({});
        expect(sign).not.toHaveBeenCalled();
    });

    it('refuses to mint a credential for a foreign organization in connection metadata', async () => {
        await expect(
            (service as any).formatConnection(
                { ...connection, organizationId: 'victim' },
                'org-1',
            ),
        ).rejects.toThrow('organization mismatch');
        expect(sign).not.toHaveBeenCalled();
    });

    it('refuses to mint a credential without a signing secret', async () => {
        delete process.env.API_JWT_SECRET;
        await expect(
            (service as any).formatConnection(connection, 'org-1'),
        ).rejects.toThrow('signing secret is missing');
        expect(sign).not.toHaveBeenCalled();
    });
});
