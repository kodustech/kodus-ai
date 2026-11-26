/**
 * Where an org's MCP server URL may lead, on the manager's side:
 *  - a custom server URL is refused on save when it resolves to the platform's
 *    private network (cloud) or the metadata service (anywhere);
 *  - a managed integration connects to its catalog URL, never to one sent in
 *    the request body, since the integration's credential goes with every call.
 * No network: the resolver is replaced.
 */
import { BadRequestException } from '@nestjs/common';
import * as dns from 'dns';

jest.mock('dns', () => {
    const actual = jest.requireActual('dns');
    return { ...actual, promises: { ...actual.promises, lookup: jest.fn() } };
});
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));
jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    ...jest.requireActual('@libs/mcp-server/mcp-adapter'),
    createMCPAdapter: jest.fn(),
}));

import { IntegrationsService } from '../../src/modules/integrations/integrations.service';
import { McpService } from '../../src/modules/mcp/mcp.service';
import { MCPIntegrationAuthType } from '../../src/modules/integrations/enums/integration.enum';

const { environment } = jest.requireMock('@libs/ee/configs/environment');
const lookup = dns.promises.lookup as unknown as jest.Mock;
const resolvesTo = (address: string) =>
    lookup.mockResolvedValue([
        { address, family: address.includes(':') ? 6 : 4 },
    ]);

function integrationsService() {
    const integrationRepository = {
        create: jest.fn((e) => e),
        save: jest.fn(async (e) => ({ id: 'int-1', ...e })),
        findOne: jest.fn(async () => ({
            id: 'int-1',
            organizationId: 'org-1',
        })),
        update: jest.fn(async () => undefined),
    };
    const encryption = { encrypt: (v: string) => v, decrypt: (v: string) => v };
    const oauth = { deleteOAuthState: jest.fn(async () => undefined) };
    const service = new IntegrationsService(
        integrationRepository as any,
        encryption as any,
        oauth as any,
    );
    return { service, integrationRepository };
}

const dto = (baseUrl: string) =>
    ({
        baseUrl,
        name: 'internal',
        authType: MCPIntegrationAuthType.NONE,
        protocol: 'http',
    }) as any;

beforeEach(() => {
    lookup.mockReset();
    environment.API_CLOUD_MODE = true;
});

describe('a custom MCP server URL on save', () => {
    it('cloud: a URL that resolves to a private address is refused and not stored', async () => {
        const { service, integrationRepository } = integrationsService();
        resolvesTo('10.0.12.7');
        await expect(
            service.createIntegration(
                'org-1',
                dto('https://mcp.attacker.test/mcp'),
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(integrationRepository.save).not.toHaveBeenCalled();
    });

    it('cloud: an edit onto a private address is refused and not stored', async () => {
        const { service, integrationRepository } = integrationsService();
        resolvesTo('::ffff:169.254.169.254');
        await expect(
            service.editIntegration(
                'org-1',
                'int-1',
                dto('https://mcp.attacker.test/mcp'),
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(integrationRepository.update).not.toHaveBeenCalled();
    });

    it('cloud: a public server is stored', async () => {
        const { service, integrationRepository } = integrationsService();
        resolvesTo('93.184.216.34');
        await service.createIntegration(
            'org-1',
            dto('https://mcp.example.com/mcp'),
        );
        expect(integrationRepository.save).toHaveBeenCalled();
    });

    it('self-hosted: a server on the operator network is stored, as before', async () => {
        environment.API_CLOUD_MODE = false;
        const { service, integrationRepository } = integrationsService();
        resolvesTo('10.0.12.7');
        await service.createIntegration(
            'org-1',
            dto('http://mcp.internal:8080/mcp'),
        );
        expect(integrationRepository.save).toHaveBeenCalled();
    });

    it('self-hosted: the metadata service is refused', async () => {
        environment.API_CLOUD_MODE = false;
        const { service } = integrationsService();
        await expect(
            service.createIntegration(
                'org-1',
                dto('http://169.254.169.254/latest/'),
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a non-http scheme is refused', async () => {
        const { service } = integrationsService();
        await expect(
            service.createIntegration('org-1', dto('file:///etc/passwd')),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('a managed integration connects to its catalog URL', () => {
    function mcpService(catalogBaseUrl: string | undefined) {
        const kodusProvider = {
            getIntegration: jest.fn(async () => ({
                appName: 'Linear',
                baseUrl: catalogBaseUrl,
            })),
            getIntegrationTools: jest.fn(async () => [{ slug: 'list_issues' }]),
        };
        const connectionRepository = {
            findOne: jest.fn(async () => null),
            create: jest.fn((e) => e),
            save: jest.fn(async (e) => e),
        };
        const service = new McpService(
            { getProvider: () => kodusProvider } as any,
            connectionRepository as any,
            {} as any,
            {} as any,
            {} as any,
        );
        return { service, connectionRepository };
    }

    it('a URL in the request body does not replace the catalog one', async () => {
        const { service, connectionRepository } = mcpService(
            'https://mcp.linear.app/mcp',
        );
        await service.createIntegration('org-1', 'kodusmcp', {
            integrationId: 'linear-default',
            baseUrl: 'https://collector.attacker.test/mcp',
        } as any);
        expect(connectionRepository.save.mock.calls[0][0].mcpUrl).toBe(
            'https://mcp.linear.app/mcp',
        );
    });

    it('an integration the catalog gives no URL keeps the one it was created with', async () => {
        const { service, connectionRepository } = mcpService(undefined);
        await service.createIntegration('org-1', 'kodusmcp', {
            integrationId: 'kodus-mcp',
            baseUrl: 'https://api.kodus.io/mcp',
        } as any);
        expect(connectionRepository.save.mock.calls[0][0].mcpUrl).toBe(
            'https://api.kodus.io/mcp',
        );
    });
});
