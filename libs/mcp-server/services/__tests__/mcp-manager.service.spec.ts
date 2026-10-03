import { JwtService } from '@nestjs/jwt';

import {
    KODUS_ISSUES_INTEGRATION_ID,
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
                    mcpUrl: 'https://legacy.kodus.io/mcp/',
                    allowedTools: ['KODUS_LIST_REPOSITORIES'],
                    metadata: {
                        connection: {
                            id: 'connection-1',
                            mcpUrl: 'https://legacy.kodus.io/mcp/',
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
    const post = jest.fn().mockResolvedValue(undefined);
    const get = jest.fn();
    const pluginChanged = jest.fn().mockResolvedValue(undefined);
    const service = new MCPManagerService(
        { sign } as any,
        { shouldLimitResources: jest.fn().mockResolvedValue(false) } as any,
        { pluginChanged } as any,
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
        (service as any).axiosMCPManagerService = { post, get };
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

    it.each([
        'https://api.kodus.io/mcp/',
        'HTTPS://API.KODUS.IO/mcp',
        'https://legacy.kodus.io/mcp',
        'https://other.example/mcp',
    ])(
        'routes stored URL %s to the configured endpoint before attaching credentials',
        async (storedUrl) => {
            const result = await (service as any).formatConnection(
                { ...connection, mcpUrl: storedUrl },
                'org-1',
            );
            expect(result.url).toBe('https://api.kodus.io/mcp');
            expect(result.headers).toEqual({
                Authorization: 'Bearer signed-token',
            });
            expect(sign).toHaveBeenCalledWith(
                { organizationId: 'org-1' },
                expect.objectContaining({ audience: 'kodus-mcp-server' }),
            );
        },
    );

    it.each([
        ['https://api.kodus.io', 'https://api.kodus.io/mcp'],
        ['https://api.kodus.io/', 'https://api.kodus.io/mcp'],
        ['https://api.kodus.io/mcp/', 'https://api.kodus.io/mcp'],
    ])(
        'resolves the configured endpoint %s to the MCP controller path',
        async (configuredUrl, expected) => {
            process.env.API_KODUS_MCP_SERVER_URL = configuredUrl;
            const result = await (service as any).formatConnection(
                connection,
                'org-1',
            );
            expect(result.url).toBe(expected);
        },
    );

    it.each([
        undefined,
        '',
        'not-a-url',
        'file:///tmp/mcp',
        'https://user:password@api.kodus.io/mcp',
        'https://api.kodus.io/api',
        'https://api.kodus.io/mcp/issues',
        'https://kodus.example/api/mcp',
    ])(
        'refuses to mint credentials with an invalid configured endpoint (%s)',
        async (configuredUrl) => {
            if (configuredUrl === undefined)
                delete process.env.API_KODUS_MCP_SERVER_URL;
            else process.env.API_KODUS_MCP_SERVER_URL = configuredUrl;
            await expect(
                (service as any).formatConnection(connection, 'org-1'),
            ).rejects.toThrow('Kodus MCP endpoint');
            expect(sign).not.toHaveBeenCalled();
        },
    );

    it.each([
        'https://api.kodus.io/mcp/issues',
        'http://kodus-api:3001/mcp/issues',
        'https://other.example/mcp/issues',
    ])(
        'signs the Git Issues MCP (%s) for the issues path of the configured origin',
        async (storedUrl) => {
            const result = await (service as any).formatConnection(
                {
                    integrationId: KODUS_ISSUES_INTEGRATION_ID,
                    provider: 'kodusmcp',
                    organizationId: 'org-1',
                    mcpUrl: storedUrl,
                },
                'org-1',
            );
            expect(result.url).toBe('https://api.kodus.io/mcp/issues');
            expect(result.headers.Authorization).toBe('Bearer signed-token');
            expect(sign).toHaveBeenCalledWith(
                { organizationId: 'org-1' },
                expect.objectContaining({ audience: 'kodus-mcp-server' }),
            );
        },
    );

    it('refuses to sign the Git Issues MCP for another organization', async () => {
        await expect(
            (service as any).formatConnection(
                {
                    integrationId: KODUS_ISSUES_INTEGRATION_ID,
                    provider: 'kodusmcp',
                    organizationId: 'victim-org',
                    mcpUrl: 'https://api.kodus.io/mcp/issues',
                },
                'org-1',
            ),
        ).rejects.toThrow('organization mismatch');
        expect(sign).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ audience: 'kodus-mcp-server' }),
        );
    });

    it('refuses to mint a credential for a foreign organization in connection metadata', async () => {
        await expect(
            (service as any).formatConnection(
                {
                    ...connection,
                    organizationId: 'victim',
                    mcpUrl: 'https://other.example/mcp',
                },
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

    it.each([undefined, '', 'not-a-url', 'file:///tmp/mcp'])(
        'does not create a connection with an invalid endpoint (%s)',
        async (configuredUrl) => {
            if (configuredUrl === undefined)
                delete process.env.API_KODUS_MCP_SERVER_URL;
            else process.env.API_KODUS_MCP_SERVER_URL = configuredUrl;
            await service.createKodusMCPIntegration('org-1');
            expect(post).not.toHaveBeenCalled();
            expect(sign).not.toHaveBeenCalled();
            expect(pluginChanged).not.toHaveBeenCalled();
            expect((service as any).logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: expect.any(Error),
                    metadata: { organizationId: 'org-1' },
                }),
            );
        },
    );

    it('creates a connection using the validated canonical endpoint', async () => {
        process.env.API_KODUS_MCP_SERVER_URL = 'HTTPS://API.KODUS.IO/mcp';
        await service.createKodusMCPIntegration('org-1');
        expect(post).toHaveBeenCalledWith(
            'mcp/integration/kodusmcp',
            {
                integrationId: KODUS_MCP_INTEGRATION_ID,
                baseUrl: connection.mcpUrl,
            },
            expect.any(Object),
        );
        expect(pluginChanged).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                installed: true,
            }),
        );
    });

    it('logs the identity of an omitted connection and preserves other connections', async () => {
        delete process.env.API_KODUS_MCP_SERVER_URL;
        get.mockResolvedValue({
            items: [
                { ...connection, id: 'connection-1', appName: 'Kodus MCP' },
                {
                    ...connection,
                    id: 'connection-2',
                    appName: 'Other MCP',
                    integrationId: 'other-integration',
                },
            ],
        });
        const result = await service.getConnections({
            organizationId: 'org-1',
        });
        expect(result).toEqual([
            expect.objectContaining({ name: 'Other MCP', headers: {} }),
        ]);
        expect(sign).toHaveBeenCalledTimes(1); // MCP manager request only.
        expect((service as any).logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.any(Error),
                metadata: {
                    organizationId: 'org-1',
                    connection: 'Kodus MCP',
                    connectionId: 'connection-1',
                },
            }),
        );
    });
});
