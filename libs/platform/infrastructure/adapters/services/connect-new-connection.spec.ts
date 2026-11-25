import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';

/**
 * Adding a connection beside the workspace's others must create a new one,
 * never reconnect the workspace's existing (or a stale inactive) row of the
 * same platform, and must answer the new connection's id.
 */
const make = <T extends object>(
    cls: { prototype: T },
    overrides: Record<string, unknown>,
) => {
    const service = Object.create(cls.prototype) as T;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    for (const [key, value] of Object.entries({ logger, ...overrides })) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
const created = { success: true, status: 'SUCCESS', integrationId: 'new-conn' };

describe.each([
    [
        'Bitbucket Cloud',
        BitbucketCloudService,
        { username: 'u', email: 'u@example.test' },
    ],
    [
        'Bitbucket Data Center',
        BitbucketDataCenterService,
        { username: 'u', host: 'https://bitbucket.example.test' },
    ],
    [
        'Azure Repos',
        AzureReposService,
        { orgName: 'acme', orgUrl: 'https://dev.azure.com/acme' },
    ],
])('%s createAuthIntegration', (_name, cls, extra) => {
    it('asks for a new connection and answers its id', async () => {
        const authenticateWithToken = jest.fn().mockResolvedValue(created);
        const service = make(cls as { prototype: object }, {
            authenticateWithToken,
            mcpManagerService: { createKodusMCPIntegration: jest.fn() },
        }) as { createAuthIntegration: (p: unknown) => Promise<unknown> };

        const result = await service.createAuthIntegration({
            organizationAndTeamData,
            authMode: AuthMode.TOKEN,
            token: 'secret',
            newConnection: true,
            ...extra,
        });

        expect(authenticateWithToken).toHaveBeenCalledWith(
            expect.objectContaining({ newConnection: true }),
        );
        expect(result).toMatchObject({ integrationId: 'new-conn' });
    });
});
