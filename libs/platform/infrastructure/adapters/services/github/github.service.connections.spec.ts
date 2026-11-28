import { BadRequestException } from '@nestjs/common';

import { GithubService } from './github.service';
import { sealInstallationState } from './installation-authorization';

/**
 * A workspace can hold several GitHub connections. Adding one creates a new
 * connection instead of rewriting the one already there, and the steps after
 * the link act on the connection just created.
 */
describe('GitHub connections in one workspace', () => {
    const ORG = 'org-1';
    const USER = 'user-1';
    const INSTALLATION = '4242';

    const setupOauth = (
        opts: {
            linkedInOrg?: boolean;
            existing?: Array<{
                uuid: string;
                authIntegration: {
                    uuid: string;
                    authDetails: { installationId: number };
                };
            }>;
        } = {},
    ) => {
        const svc: any = Object.create(GithubService.prototype);
        const appOctokit = {
            auth: jest.fn(async (args: any) =>
                args.type === 'oauth-user'
                    ? { token: 'ghu_user_token' }
                    : { token: 'ghs_installation', installationId: 4242 },
            ),
            rest: {
                apps: {
                    getInstallation: jest.fn().mockResolvedValue({
                        data: {
                            account: { login: 'second-org' },
                            target_type: 'Organization',
                        },
                    }),
                },
            },
        };
        svc.assertGithubOAuthEnv = jest.fn();
        svc.configService = { get: () => 'https://app.example.test/' };
        svc.createOctokitInstance = jest.fn().mockReturnValue(appOctokit);
        svc.createUserOctokit = jest.fn().mockReturnValue({
            paginate: jest.fn().mockResolvedValue([{ id: 4242 }]),
        });
        // The installation's links: those of the existing connections that
        // hold it (this workspace), plus another workspace's when asked.
        const existingLinks = (opts.existing ?? [])
            .filter(
                (connection) =>
                    connection.authIntegration.authDetails.installationId ===
                    4242,
            )
            .map(() => ({
                organization: { uuid: ORG },
                team: { uuid: 't1' },
            }));
        svc.authIntegrationService = {
            find: jest.fn(async (filter: any) =>
                typeof filter.authDetails.installationId === 'number'
                    ? [
                          ...existingLinks,
                          ...(opts.linkedInOrg
                              ? [
                                    {
                                        organization: { uuid: ORG },
                                        team: { uuid: 'other-workspace' },
                                    },
                                ]
                              : []),
                      ]
                    : [],
            ),
        };
        svc.checkRepositoryPermissions = jest
            .fn()
            .mockResolvedValue({ success: true });
        const existing = opts.existing ?? [
            {
                uuid: 'existing-gh',
                authIntegration: {
                    uuid: 'auth-existing',
                    authDetails: { installationId: 1111 },
                },
            },
        ];
        svc.integrationService = {
            findOne: jest.fn().mockResolvedValue(existing[0]),
            find: jest.fn().mockResolvedValue(existing),
        };
        svc.addAccessToken = jest.fn().mockResolvedValue({ uuid: 'new-gh' });
        svc.updateAuthIntegration = jest.fn().mockResolvedValue(undefined);
        svc.findOneByOrganizationId = jest
            .fn()
            .mockResolvedValue({ installationStatus: 'PENDING' });
        svc.updateInstallationItems = jest.fn().mockResolvedValue(undefined);
        svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        return svc;
    };

    const link = (svc: any, over: Record<string, unknown> = {}) =>
        svc.authenticateWithCodeOauth({
            code: INSTALLATION,
            authMode: 'OAUTH',
            userId: USER,
            githubCode: 'gh-code',
            githubState: sealInstallationState({
                installationId: INSTALLATION,
                userId: USER,
                organizationId: ORG,
            }),
            organizationAndTeamData: { organizationId: ORG, teamId: 't1' },
            ...over,
        });

    it('creates a new connection beside the existing one when asked to', async () => {
        const svc = setupOauth();

        const result = await link(svc, { newConnection: true });

        expect(svc.updateAuthIntegration).not.toHaveBeenCalled();
        expect(svc.addAccessToken).toHaveBeenCalled();
        expect(result).toEqual(
            expect.objectContaining({ success: true, integrationId: 'new-gh' }),
        );
    });

    it('records the installation status on the connection it just created', async () => {
        const svc = setupOauth();

        await link(svc, { newConnection: true });

        const connectionTeamData = {
            organizationId: ORG,
            teamId: 't1',
            integrationId: 'new-gh',
        };
        expect(svc.findOneByOrganizationId).toHaveBeenCalledWith(
            connectionTeamData,
        );
        expect(svc.updateInstallationItems).toHaveBeenCalledWith(
            expect.anything(),
            connectionTeamData,
        );
    });

    it('updates the existing connection when no new one is asked for', async () => {
        const svc = setupOauth();

        const result = await link(svc);

        expect(svc.addAccessToken).not.toHaveBeenCalled();
        expect(svc.updateAuthIntegration).toHaveBeenCalledWith(
            expect.objectContaining({ integrationId: 'existing-gh' }),
        );
        expect(result.integrationId).toBe('existing-gh');
    });

    it('reconnects the connection holding the installation, even when asked for a new one', async () => {
        const svc = setupOauth({
            existing: [
                {
                    uuid: 'gh-a',
                    authIntegration: {
                        uuid: 'auth-a',
                        authDetails: { installationId: 1111 },
                    },
                },
                {
                    uuid: 'gh-b',
                    authIntegration: {
                        uuid: 'auth-b',
                        authDetails: { installationId: 4242 },
                    },
                },
            ],
        });

        const result = await link(svc, { newConnection: true });

        expect(svc.addAccessToken).not.toHaveBeenCalled();
        expect(svc.updateAuthIntegration).toHaveBeenCalledWith(
            expect.objectContaining({ integrationId: 'gh-b' }),
        );
        expect(result.integrationId).toBe('gh-b');
    });

    it('refuses to rewrite one of several GitHub connections that the installation does not belong to', async () => {
        const svc = setupOauth({
            existing: [
                {
                    uuid: 'gh-a',
                    authIntegration: {
                        uuid: 'auth-a',
                        authDetails: { installationId: 1111 },
                    },
                },
                {
                    uuid: 'gh-c',
                    authIntegration: {
                        uuid: 'auth-c',
                        authDetails: { installationId: 3333 },
                    },
                },
            ],
        });

        await expect(link(svc)).rejects.toThrow(BadRequestException);
        expect(svc.updateAuthIntegration).not.toHaveBeenCalled();
        expect(svc.addAccessToken).not.toHaveBeenCalled();
    });

    it('refuses to add an installation already connected in the organization', async () => {
        const svc = setupOauth({ linkedInOrg: true });

        await expect(link(svc, { newConnection: true })).rejects.toThrow(
            BadRequestException,
        );
        expect(svc.addAccessToken).not.toHaveBeenCalled();
    });

    it('creates a new token connection when asked to', async () => {
        const svc: any = Object.create(GithubService.prototype);
        svc.createUserOctokitClient = jest.fn().mockReturnValue({
            rest: {
                users: {
                    getAuthenticated: jest
                        .fn()
                        .mockResolvedValue({ data: { login: 'someone' } }),
                },
                orgs: {
                    listForAuthenticatedUser: jest
                        .fn()
                        .mockResolvedValue({ data: [] }),
                },
            },
        });
        svc.checkRepositoryPermissions = jest
            .fn()
            .mockResolvedValue({ success: true });
        svc.integrationService = {
            findOne: jest.fn().mockResolvedValue({ uuid: 'existing-gh' }),
            find: jest.fn().mockResolvedValue([{ uuid: 'existing-gh' }]),
        };
        svc.addAccessToken = jest.fn().mockResolvedValue({ uuid: 'new-pat' });
        svc.updateAuthIntegration = jest.fn();

        const result = await svc.authenticateWithToken({
            token: 'ghp_x',
            newConnection: true,
            organizationAndTeamData: { organizationId: ORG, teamId: 't1' },
        });

        expect(svc.integrationService.findOne).not.toHaveBeenCalled();
        expect(result.integrationId).toBe('new-pat');
    });
});

describe('GitHub Reset of one connection', () => {
    const resetSetup = (sharedWith: string[]) => {
        const svc: any = Object.create(GithubService.prototype);
        const deleteInstallation = jest.fn().mockResolvedValue(undefined);
        svc.createOctokitInstance = jest
            .fn()
            .mockReturnValue({ apps: { deleteInstallation } });
        svc.integrationService = {
            findOne: jest.fn().mockResolvedValue({
                uuid: 'gh-a',
                authIntegration: {
                    uuid: 'auth-a',
                    authDetails: { authMode: 'oauth', installationId: 4242 },
                },
            }),
        };
        svc.authIntegrationService = {
            find: jest.fn(async (filter: any) =>
                typeof filter.authDetails.installationId === 'number'
                    ? [
                          { uuid: 'auth-a' },
                          ...sharedWith.map((uuid) => ({ uuid })),
                      ]
                    : [],
            ),
        };
        svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        return { svc, deleteInstallation };
    };

    const reset = (svc: any) =>
        svc.deleteWebhook({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 't1',
                integrationId: 'gh-a',
            },
        });

    it('uninstalls the GitHub App when no other connection uses the installation', async () => {
        const { svc, deleteInstallation } = resetSetup([]);

        await reset(svc);

        expect(deleteInstallation).toHaveBeenCalledWith({
            installation_id: 4242,
        });
    });

    it('keeps the GitHub App installed while another connection uses it', async () => {
        const { svc, deleteInstallation } = resetSetup(['auth-b']);

        await reset(svc);

        expect(deleteInstallation).not.toHaveBeenCalled();
        expect(svc.logger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    sharedWithAuthIntegrationIds: ['auth-b'],
                }),
            }),
        );
    });
});
