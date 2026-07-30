import { BadRequestException } from '@nestjs/common';

// createMCPAdapter now comes from the in-repo @libs/mcp-server/mcp-adapter.
jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    ...jest.requireActual('@libs/mcp-server/mcp-adapter'),
    createMCPAdapter: jest.fn(),
}));

import { McpService } from '../../src/modules/mcp/mcp.service';
import { MCPConnectionStatus } from '../../src/modules/mcp/entities/mcp-connection.entity';
import { MCPIntegrationAuthType } from '../../src/modules/integrations/enums/integration.enum';

const INT = 'atlassian-rovo-default';
const ORG = 'org-1';

const authMethods = [
    {
        id: 'oauth',
        type: MCPIntegrationAuthType.OAUTH2,
        dynamicRegistration: true,
        default: true,
    },
    {
        id: 'token',
        type: MCPIntegrationAuthType.BASIC,
        userFields: [
            { name: 'email', required: true },
            { name: 'apiToken', required: true, secret: true },
            { name: 'cloudId', required: true },
        ],
    },
];

function buildService() {
    const kodusProvider = {
        getAuthMethods: jest.fn().mockReturnValue(authMethods),
        getManagedConfig: jest.fn().mockReturnValue({
            id: INT,
            name: 'Atlassian Rovo',
            baseUrl: 'https://mcp.atlassian.com/v1/mcp',
            protocol: 'http',
            logoUrl: '',
        }),
        getIntegrationTools: jest.fn().mockResolvedValue([
            { slug: 'getJiraIssue', readOnly: true },
            { slug: 'searchJiraIssues', readOnly: true },
            { slug: 'createJiraIssue', readOnly: false },
        ]),
        // Verification lists tools with the just-saved credential.
        verifyManagedConnection: jest.fn().mockResolvedValue([
            { slug: 'getJiraIssue', readOnly: true },
            { slug: 'searchJiraIssues', readOnly: true },
            { slug: 'createJiraIssue', readOnly: false },
        ]),
    };
    const providerFactory = {
        getProvider: jest.fn().mockReturnValue(kodusProvider),
    };
    const connectionRepository = {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    const integrationOAuthService = {
        saveTokenCredential: jest.fn().mockResolvedValue(undefined),
        deleteOAuthState: jest.fn().mockResolvedValue(undefined),
    };

    const service = new McpService(
        providerFactory as any,
        connectionRepository as any,
        {} as any,
        {} as any,
        integrationOAuthService as any,
    );

    return {
        service,
        connectionRepository,
        integrationOAuthService,
        kodusProvider,
    };
}

describe('McpService.connectManagedToken', () => {
    it('stores the credential and creates an ACTIVE connection for a valid submission', async () => {
        const { service, connectionRepository, integrationOAuthService } =
            buildService();

        const result = await service.connectManagedToken(ORG, INT, {
            authMethod: 'token',
            secret: 'api-token',
            fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
        });

        expect(integrationOAuthService.saveTokenCredential).toHaveBeenCalledWith(
            ORG,
            INT,
            {
                authMethodId: 'token',
                authType: MCPIntegrationAuthType.BASIC,
                secret: 'api-token',
                fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
            },
        );

        expect(connectionRepository.save).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            integrationId: INT,
            organizationId: ORG,
            provider: 'kodusmcp',
            status: MCPConnectionStatus.ACTIVE,
            mcpUrl: 'https://mcp.atlassian.com/v1/mcp',
            appName: 'Atlassian Rovo',
            metadata: { authMethod: 'token' },
        });
        // Defaults to the read-only tools, not the write one.
        expect(result.allowedTools).toEqual([
            'getJiraIssue',
            'searchJiraIssues',
        ]);
    });

    it('rejects when the token verifies to zero tools and rolls back the credential', async () => {
        const {
            service,
            connectionRepository,
            integrationOAuthService,
            kodusProvider,
        } = buildService();
        kodusProvider.verifyManagedConnection.mockResolvedValue([]);

        await expect(
            service.connectManagedToken(ORG, INT, {
                authMethod: 'token',
                secret: 'bad',
                fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(integrationOAuthService.saveTokenCredential).toHaveBeenCalled();
        expect(integrationOAuthService.deleteOAuthState).toHaveBeenCalledWith(
            ORG,
            INT,
        );
        expect(connectionRepository.save).not.toHaveBeenCalled();
    });

    it('rejects when verification throws (e.g. 401) and rolls back the credential', async () => {
        const {
            service,
            connectionRepository,
            integrationOAuthService,
            kodusProvider,
        } = buildService();
        kodusProvider.verifyManagedConnection.mockRejectedValue(
            new Error('401 Unauthorized'),
        );

        await expect(
            service.connectManagedToken(ORG, INT, {
                authMethod: 'token',
                secret: 'bad',
                fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(integrationOAuthService.deleteOAuthState).toHaveBeenCalledWith(
            ORG,
            INT,
        );
        expect(connectionRepository.save).not.toHaveBeenCalled();
    });

    it('rejects an invalid submission without storing anything', async () => {
        const { service, connectionRepository, integrationOAuthService } =
            buildService();

        await expect(
            service.connectManagedToken(ORG, INT, {
                authMethod: 'token',
                secret: 'api-token',
                fields: { email: 'dev@kodus.io' }, // missing cloudId
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(integrationOAuthService.saveTokenCredential).not.toHaveBeenCalled();
        expect(connectionRepository.save).not.toHaveBeenCalled();
    });

    it('rejects an unknown auth method', async () => {
        const { service } = buildService();

        await expect(
            service.connectManagedToken(ORG, INT, {
                authMethod: 'nope',
                secret: 'x',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
