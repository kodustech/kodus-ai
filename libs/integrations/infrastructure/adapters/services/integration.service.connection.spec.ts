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

const connection = (uuid: string, platform: PlatformType, status = true) => ({
    uuid,
    platform,
    integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
    status,
    authIntegration: { uuid: `auth-${uuid}`, authDetails: { org: uuid } },
});

const fullNamesOf = (repo: Record<string, string>) =>
    [
        repo.full_name,
        repo.organizationName && repo.name
            ? `${repo.organizationName}/${repo.name}`
            : undefined,
        repo.name,
    ]
        .filter((name): name is string => !!name && name.includes('/'))
        .map((name) => name.toLowerCase());

const makeService = (
    connections: ReturnType<typeof connection>[],
    reposByConnection: Record<string, Array<Record<string, string>>> = {},
) => {
    const integrationRepository = {
        find: jest
            .fn()
            .mockImplementation(async (filter: any) =>
                connections.filter(
                    (c) =>
                        (!filter?.platform || c.platform === filter.platform) &&
                        (filter?.status === undefined ||
                            c.status === filter.status),
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
        findRepositoryListings: jest
            .fn()
            .mockImplementation(async ({ integrationIds, repository }: any) =>
                integrationIds.flatMap((integrationId: string) =>
                    (reposByConnection[integrationId] ?? [])
                        .filter((repo) =>
                            repository.id != null
                                ? String(repo.id) === String(repository.id)
                                : repository.fullName
                                  ? fullNamesOf(repo).includes(
                                        repository.fullName.toLowerCase(),
                                    )
                                  : repo.name === repository.name,
                        )
                        .map((repo) => ({ integrationId, repository: repo })),
                ),
            ),
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

    it('refuses, and logs, when a workspace has two connections on the platform and none is named', async () => {
        const { service } = makeService([
            connection('gh-a', PlatformType.GITHUB),
            connection('gh-b', PlatformType.GITHUB),
        ]);

        const details = await service.getPlatformAuthDetails<{
            integrationId: string;
        }>(ORG_TEAM, PlatformType.GITHUB);

        expect(details).toBeNull();
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

describe('IntegrationService — connection lookups stay deterministic and fail closed', () => {
    beforeEach(() => jest.clearAllMocks());

    it("reads an active connection's credentials over an inactive row of the platform", async () => {
        const { service } = makeService([
            connection('gh-old', PlatformType.GITHUB, false),
            connection('gh-a', PlatformType.GITHUB),
        ]);

        const details = await service.getPlatformAuthDetails<{
            integrationId: string;
        }>(ORG_TEAM, PlatformType.GITHUB);

        expect(details.integrationId).toBe('gh-a');
    });

    it('breaks a repository id listed by two connections with the full name', async () => {
        const { service } = makeService(
            [
                connection('gl-cloud', PlatformType.GITLAB),
                connection('gl-acme', PlatformType.GITLAB),
            ],
            {
                'gl-cloud': [{ id: '42', name: 'tools/api' }],
                'gl-acme': [
                    { id: '42', name: 'api', organizationName: 'acme' },
                ],
            },
        );

        const result = await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { id: '42', fullName: 'acme/api' },
        });

        expect(result.integration?.uuid).toBe('gl-acme');
        expect(result.ambiguous).toBe(false);
    });

    it('breaks a repository id listed by two Azure connections with the bare name Azure records', async () => {
        const { service } = makeService(
            [
                connection('az-a', PlatformType.AZURE_REPOS),
                connection('az-b', PlatformType.AZURE_REPOS),
            ],
            {
                'az-a': [{ id: '42', name: 'web', organizationName: 'proj' }],
                'az-b': [{ id: '42', name: 'api', organizationName: 'proj' }],
            },
        );

        const result = await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { id: '42', fullName: 'api' },
        });

        expect(result.integration?.uuid).toBe('az-b');
        expect(result.ambiguous).toBe(false);
    });

    it('stays ambiguous when the full name does not tell the listings apart', async () => {
        const { service } = makeService(
            [
                connection('gl-cloud', PlatformType.GITLAB),
                connection('gl-acme', PlatformType.GITLAB),
            ],
            {
                'gl-cloud': [{ id: '42', full_name: 'acme/api' }],
                'gl-acme': [{ id: '42', full_name: 'acme/api' }],
            },
        );

        const result = await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { id: '42', fullName: 'acme/api' },
        });

        expect(result.integration).toBeUndefined();
        expect(result.ambiguous).toBe(true);
    });

    it('reads every candidate listing in one query', async () => {
        const { service, integrationConfigService } = makeService(
            [
                connection('gh-a', PlatformType.GITHUB),
                connection('gh-b', PlatformType.GITHUB),
                connection('gh-c', PlatformType.GITHUB),
            ],
            { 'gh-b': [{ id: '9', name: 'api' }] },
        );

        const result = await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { id: '9' },
        });

        expect(result.integration?.uuid).toBe('gh-b');
        expect(
            integrationConfigService.findRepositoryListings,
        ).toHaveBeenCalledTimes(1);
        expect(
            integrationConfigService.findRepositoryListings,
        ).toHaveBeenCalledWith({
            teamId: 'team-1',
            integrationIds: ['gh-a', 'gh-b', 'gh-c'],
            repository: { id: '9' },
        });
        expect(integrationConfigService.findOne).not.toHaveBeenCalled();
    });

    it('looks nothing up without a workspace', async () => {
        const { service, integrationRepository } = makeService([
            connection('gh-a', PlatformType.GITHUB),
        ]);

        const result = await service.resolveCodeManagementConnection(
            { organizationId: 'org-1', teamId: undefined } as any,
            { platform: PlatformType.GITHUB },
        );

        expect(result.integration).toBeUndefined();
        expect(integrationRepository.find).not.toHaveBeenCalled();
    });

    it('looks nothing up without an organization', async () => {
        const { service, integrationRepository } = makeService([
            connection('gh-a', PlatformType.GITHUB),
        ]);

        const result = await service.resolveCodeManagementConnection(
            { organizationId: undefined, teamId: undefined } as any,
            { platform: PlatformType.GITHUB, repository: { id: '1' } },
        );

        expect(result).toEqual({
            integration: undefined,
            platform: null,
            ambiguous: false,
        });
        expect(integrationRepository.find).not.toHaveBeenCalled();
        expect(integrationRepository.findOne).not.toHaveBeenCalled();
    });
});

describe('IntegrationService — repeated resolution', () => {
    beforeEach(() => jest.clearAllMocks());

    it('answers the same question again from memory for a few seconds', async () => {
        const { service, integrationRepository, integrationConfigService } =
            makeService(
                [
                    connection('gh-a', PlatformType.GITHUB),
                    connection('gh-b', PlatformType.GITHUB),
                ],
                { 'gh-b': [{ id: '9', name: 'api' }] },
            );

        const [first, second] = await Promise.all([
            service.resolveCodeManagementConnection(ORG_TEAM, {
                repository: { id: '9' },
            }),
            service.resolveCodeManagementConnection(ORG_TEAM, {
                repository: { id: '9' },
            }),
        ]);
        const third = await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { id: '9' },
        });

        expect([first, second, third].map((r) => r.integration?.uuid)).toEqual([
            'gh-b',
            'gh-b',
            'gh-b',
        ]);
        expect(integrationRepository.find).toHaveBeenCalledTimes(1);
        expect(
            integrationConfigService.findRepositoryListings,
        ).toHaveBeenCalledTimes(1);
    });

    it('does not share an answer between workspaces or repositories', async () => {
        const { service, integrationRepository } = makeService(
            [
                connection('gh-a', PlatformType.GITHUB),
                connection('gh-b', PlatformType.GITHUB),
            ],
            { 'gh-b': [{ id: '9', name: 'api' }] },
        );

        await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { id: '9' },
        });
        await service.resolveCodeManagementConnection(ORG_TEAM, {
            repository: { id: '10' },
        });
        await service.resolveCodeManagementConnection(
            { ...ORG_TEAM, teamId: 'team-2' },
            { repository: { id: '9' } },
        );

        expect(integrationRepository.find).toHaveBeenCalledTimes(3);
    });

    it('forgets a failed lookup at once', async () => {
        const { service, integrationRepository } = makeService([
            connection('gh-a', PlatformType.GITHUB),
        ]);
        integrationRepository.find.mockRejectedValueOnce(new Error('pg down'));

        await expect(
            service.resolveCodeManagementConnection(ORG_TEAM),
        ).rejects.toThrow('pg down');
        const result = await service.resolveCodeManagementConnection(ORG_TEAM);

        expect(result.integration?.uuid).toBe('gh-a');
    });

    it('forgets every answer when a connection is written', async () => {
        const { service, integrationRepository } = makeService([
            connection('gh-a', PlatformType.GITHUB),
        ]);
        (integrationRepository as any).update = jest.fn().mockResolvedValue({});

        await service.resolveCodeManagementConnection(ORG_TEAM);
        await service.update({ uuid: 'gh-a' }, { status: false });
        await service.resolveCodeManagementConnection(ORG_TEAM);

        expect(integrationRepository.find).toHaveBeenCalledTimes(2);
    });
});
