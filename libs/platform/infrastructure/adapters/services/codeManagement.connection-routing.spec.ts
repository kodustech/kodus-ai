import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { CodeManagementService } from './codeManagement.service';

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

const build = (resolved: {
    integration?: { uuid: string; platform: PlatformType };
    platform: PlatformType | null;
    ambiguous: boolean;
}) => {
    const provider = {
        getRepositoryContentFile: jest.fn().mockResolvedValue({ ok: true }),
        getRepositories: jest.fn().mockResolvedValue([]),
    };
    const getCodeManagementService = jest.fn().mockReturnValue(provider);
    const resolveCodeManagementConnection = jest
        .fn()
        .mockResolvedValue(resolved);
    const service = make(CodeManagementService, {
        platformIntegrationFactory: { getCodeManagementService },
        integrationService: { resolveCodeManagementConnection },
    }) as CodeManagementService;
    return {
        service,
        provider,
        getCodeManagementService,
        resolveCodeManagementConnection,
    };
};

const orgTeam = () => ({ organizationId: 'org-1', teamId: 'team-1' });

describe('CodeManagementService — connection routing', () => {
    it('sends a repository call to the connection that lists the repository', async () => {
        const {
            service,
            provider,
            getCodeManagementService,
            resolveCodeManagementConnection,
        } = build({
            integration: { uuid: 'gl-b', platform: PlatformType.GITLAB },
            platform: PlatformType.GITLAB,
            ambiguous: false,
        });
        const params = {
            organizationAndTeamData: orgTeam(),
            repository: { id: '22', name: 'web', fullName: 'acme/web' },
            file: {},
            pullRequest: {},
        };

        await service.getRepositoryContentFile(params);

        expect(resolveCodeManagementConnection).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: 'team-1' },
            {
                platform: undefined,
                repository: { id: '22', name: 'web', fullName: 'acme/web' },
            },
        );
        expect(getCodeManagementService).toHaveBeenCalledWith(
            PlatformType.GITLAB,
        );
        expect(provider.getRepositoryContentFile).toHaveBeenCalledWith({
            ...params,
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
                integrationId: 'gl-b',
            },
        });
    });

    it('does not write the connection onto the caller’s object', async () => {
        const { service } = build({
            integration: { uuid: 'gl-b', platform: PlatformType.GITLAB },
            platform: PlatformType.GITLAB,
            ambiguous: false,
        });
        const organizationAndTeamData = orgTeam();

        await service.getRepositoryContentFile({
            organizationAndTeamData,
            repository: { id: '22', name: 'web' },
            file: {},
            pullRequest: {},
        });

        expect(organizationAndTeamData).toEqual(orgTeam());
    });

    it('still names the connection when the caller passes the platform', async () => {
        const { service, provider, resolveCodeManagementConnection } = build({
            integration: { uuid: 'gh-b', platform: PlatformType.GITHUB },
            platform: PlatformType.GITHUB,
            ambiguous: false,
        });

        await service.getRepositoryContentFile(
            {
                organizationAndTeamData: orgTeam(),
                repository: { id: '9', name: 'api' },
                file: {},
                pullRequest: {},
            },
            PlatformType.GITHUB,
        );

        expect(resolveCodeManagementConnection).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ platform: PlatformType.GITHUB }),
        );
        expect(provider.getRepositoryContentFile).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: expect.objectContaining({
                    integrationId: 'gh-b',
                }),
            }),
        );
    });

    it('skips the lookup when the caller already names the connection and platform', async () => {
        const { service, provider, resolveCodeManagementConnection } = build({
            platform: null,
            ambiguous: false,
        });
        const params = {
            organizationAndTeamData: { ...orgTeam(), integrationId: 'gh-a' },
            repository: { id: '9', name: 'api' },
            file: {},
            pullRequest: {},
        };

        await service.getRepositoryContentFile(params, PlatformType.GITHUB);

        expect(resolveCodeManagementConnection).not.toHaveBeenCalled();
        expect(provider.getRepositoryContentFile).toHaveBeenCalledWith(params);
    });

    it('keeps the platform but names no connection when several fit', async () => {
        const { service, provider } = build({
            platform: PlatformType.GITHUB,
            ambiguous: true,
        });
        const params = {
            organizationAndTeamData: orgTeam(),
            repository: { id: '9', name: 'api' },
            file: {},
            pullRequest: {},
        };

        await service.getRepositoryContentFile(params);

        expect(provider.getRepositoryContentFile).toHaveBeenCalledWith(params);
    });

    it('routes calls whose params carry the org and team at the top level', async () => {
        const { service, provider } = build({
            integration: { uuid: 'gh-a', platform: PlatformType.GITHUB },
            platform: PlatformType.GITHUB,
            ambiguous: false,
        });

        await service.getRepositories({
            organizationAndTeamData: orgTeam(),
        } as any);

        expect(provider.getRepositories).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: expect.objectContaining({
                    integrationId: 'gh-a',
                }),
            }),
        );
    });

    describe('listing repositories with several connections and none named', () => {
        const fanOut = (failing?: string) => {
            const providers: Record<string, { getRepositories: jest.Mock }> = {
                [PlatformType.GITHUB]: {
                    getRepositories: jest.fn(async () =>
                        failing === 'gh-a'
                            ? Promise.reject(new Error('github down'))
                            : [{ id: '1', name: 'api' }],
                    ),
                },
                [PlatformType.GITLAB]: {
                    getRepositories: jest.fn(async () => [
                        { id: '2', name: 'web' },
                    ]),
                },
            };
            const service = make(CodeManagementService, {
                platformIntegrationFactory: {
                    getCodeManagementService: jest.fn(
                        (type: PlatformType) => providers[type],
                    ),
                },
                integrationService: {
                    resolveCodeManagementConnection: jest
                        .fn()
                        .mockResolvedValue({
                            platform: null,
                            ambiguous: true,
                        }),
                    find: jest.fn().mockResolvedValue([
                        { uuid: 'gh-a', platform: PlatformType.GITHUB },
                        { uuid: 'gl-b', platform: PlatformType.GITLAB },
                    ]),
                },
            }) as CodeManagementService;
            return { service, providers };
        };

        it("lists every connection's repositories, each tagged with its connection", async () => {
            const { service, providers } = fanOut();

            const repositories = await service.getRepositories({
                organizationAndTeamData: orgTeam(),
            });

            expect(repositories).toEqual([
                { id: '1', name: 'api', connectionId: 'gh-a' },
                { id: '2', name: 'web', connectionId: 'gl-b' },
            ]);
            expect(
                providers[PlatformType.GITLAB].getRepositories,
            ).toHaveBeenCalledWith({
                organizationAndTeamData: {
                    ...orgTeam(),
                    integrationId: 'gl-b',
                },
            });
        });

        it('still lists the connections that answer when one fails', async () => {
            const { service } = fanOut('gh-a');

            await expect(
                service.getRepositories({ organizationAndTeamData: orgTeam() }),
            ).resolves.toEqual([
                { id: '2', name: 'web', connectionId: 'gl-b' },
            ]);
        });
    });
});
