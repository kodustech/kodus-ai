import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { IntegrationService } from './integration.service';

const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
};

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => mockLogger,
}));

const ORG_TEAM = { organizationId: 'org-1', teamId: 'team-1' };

const connection = (uuid: string, platform: PlatformType) => ({
    uuid,
    platform,
    integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
    status: true,
    authIntegration: { uuid: `auth-${uuid}`, authDetails: { org: uuid } },
});

const makeService = (
    connections: ReturnType<typeof connection>[],
    reposByConnection: Record<string, Array<Record<string, string>>> = {},
) => {
    const integrationRepository = {
        find: jest
            .fn()
            .mockImplementation(async (filter: any) =>
                connections.filter(
                    (c) => !filter?.platform || c.platform === filter.platform,
                ),
            ),
        findOne: jest
            .fn()
            .mockImplementation(async (filter: any) =>
                connections.find(
                    (c) =>
                        (!filter?.uuid || c.uuid === filter.uuid) &&
                        (!filter?.platform || c.platform === filter.platform),
                ),
            ),
    };
    const integrationConfigService = {
        findOne: jest.fn().mockImplementation(async (filter: any) => {
            if (filter?.configKey !== IntegrationConfigKey.REPOSITORIES) {
                return undefined;
            }
            const repos = reposByConnection[filter?.integration?.uuid];
            return repos ? { configValue: repos } : undefined;
        }),
    };
    const service = new IntegrationService(
        integrationRepository as any,
        integrationConfigService as any,
    );
    return { service, integrationRepository, integrationConfigService };
};

describe('IntegrationService.resolveCodeManagementConnection', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the connection named by integrationId', async () => {
        const { service } = makeService([
            connection('gh-a', PlatformType.GITHUB),
            connection('gh-b', PlatformType.GITHUB),
        ]);

        const result = await service.resolveCodeManagementConnection({
            ...ORG_TEAM,
            integrationId: 'gh-b',
        });

        expect(result.integration?.uuid).toBe('gh-b');
        expect(result.ambiguous).toBe(false);
    });

    it('returns the only connection of a single-connection workspace', async () => {
        const { service } = makeService([
            connection('gh-a', PlatformType.GITHUB),
        ]);

        const result = await service.resolveCodeManagementConnection(ORG_TEAM);

        expect(result.integration?.uuid).toBe('gh-a');
        expect(result.platform).toBe(PlatformType.GITHUB);
    });

    it('returns no connection when the workspace has none', async () => {
        const { service } = makeService([]);

        const result = await service.resolveCodeManagementConnection(ORG_TEAM);

        expect(result.integration).toBeUndefined();
        expect(result.platform).toBeNull();
        expect(result.ambiguous).toBe(false);
    });

    it('picks the connection whose repositories list the repository id', async () => {
        const { service } = makeService(
            [
                connection('gh-a', PlatformType.GITHUB),
                connection('gl-b', PlatformType.GITLAB),
            ],
            {
                'gh-a': [{ id: '11', name: 'api' }],
                'gl-b': [{ id: '22', name: 'web' }],
            },
        );

        const result = await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { id: 22 },
        });

        expect(result.integration?.uuid).toBe('gl-b');
        expect(result.platform).toBe(PlatformType.GITLAB);
    });

    it('matches a repository by full name when no id is given', async () => {
        const { service } = makeService(
            [
                connection('gh-a', PlatformType.GITHUB),
                connection('gh-b', PlatformType.GITHUB),
            ],
            {
                'gh-a': [{ id: '1', name: 'api', full_name: 'acme/api' }],
                'gh-b': [{ id: '2', name: 'api', full_name: 'other/api' }],
            },
        );

        const result = await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { fullName: 'other/api' },
        });

        expect(result.integration?.uuid).toBe('gh-b');
    });

    it('narrows candidates by platform before matching the repository', async () => {
        const { service } = makeService(
            [
                connection('gh-a', PlatformType.GITHUB),
                connection('gl-b', PlatformType.GITLAB),
            ],
            {
                'gh-a': [{ id: '7', name: 'api' }],
                'gl-b': [{ id: '7', name: 'web' }],
            },
        );

        const result = await service.resolveCodeManagementConnection(ORG_TEAM, {
            platform: PlatformType.GITLAB,
            repository: { id: '7' },
        });

        expect(result.integration?.uuid).toBe('gl-b');
    });

    it('reports ambiguity, and logs it, when nothing tells two connections apart', async () => {
        const { service } = makeService([
            connection('gh-a', PlatformType.GITHUB),
            connection('gl-b', PlatformType.GITLAB),
        ]);

        const result = await service.resolveCodeManagementConnection(ORG_TEAM);

        expect(result.integration).toBeUndefined();
        expect(result.ambiguous).toBe(true);
        expect(result.platform).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'connection_ambiguous',
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    candidateIds: ['gh-a', 'gl-b'],
                }),
            }),
        );
    });

    it('still answers the platform when every ambiguous candidate shares it', async () => {
        const { service } = makeService([
            connection('gh-a', PlatformType.GITHUB),
            connection('gh-b', PlatformType.GITHUB),
        ]);

        const result = await service.resolveCodeManagementConnection(ORG_TEAM);

        expect(result.ambiguous).toBe(true);
        expect(result.platform).toBe(PlatformType.GITHUB);
    });
});

describe('IntegrationService.getPlatformAuthDetails — connection id', () => {
    beforeEach(() => jest.clearAllMocks());

    it('reads the credentials of the connection named by integrationId', async () => {
        const { service, integrationRepository } = makeService([
            connection('gh-a', PlatformType.GITHUB),
            connection('gh-b', PlatformType.GITHUB),
        ]);

        const details = await service.getPlatformAuthDetails<{
            integrationId: string;
            org: string;
        }>({ ...ORG_TEAM, integrationId: 'gh-b' }, PlatformType.GITHUB);

        expect(details.integrationId).toBe('gh-b');
        expect(details.org).toBe('gh-b');
        expect(integrationRepository.findOne).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'gh-b' }),
        );
    });

    it('returns nothing when the named connection is on another platform', async () => {
        const { service } = makeService([
            connection('gl-b', PlatformType.GITLAB),
        ]);

        const details = await service.getPlatformAuthDetails(
            { ...ORG_TEAM, integrationId: 'gl-b' },
            PlatformType.GITHUB,
        );

        expect(details).toBeNull();
    });

    it('logs when a workspace has two connections on the platform and none is named', async () => {
        const { service } = makeService([
            connection('gh-a', PlatformType.GITHUB),
            connection('gh-b', PlatformType.GITHUB),
        ]);

        const details = await service.getPlatformAuthDetails<{
            integrationId: string;
        }>(ORG_TEAM, PlatformType.GITHUB);

        expect(details.integrationId).toBe('gh-a');
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'connection_ambiguous',
                metadata: expect.objectContaining({
                    platform: PlatformType.GITHUB,
                    candidateIds: ['gh-a', 'gh-b'],
                }),
            }),
        );
    });
});
