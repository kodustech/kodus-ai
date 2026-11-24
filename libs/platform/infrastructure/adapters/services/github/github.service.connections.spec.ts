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

    const setupOauth = (opts: { linkedInOrg?: boolean } = {}) => {
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
        svc.authIntegrationService = {
            find: jest.fn(async (filter: any) =>
                opts.linkedInOrg &&
                typeof filter.authDetails.installationId === 'number'
                    ? [{ organization: { uuid: ORG } }]
                    : [],
            ),
        };
        svc.checkRepositoryPermissions = jest
            .fn()
            .mockResolvedValue({ success: true });
        svc.integrationService = {
            findOne: jest.fn().mockResolvedValue({
                uuid: 'existing-gh',
                authIntegration: { uuid: 'auth-existing' },
            }),
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

        expect(svc.integrationService.findOne).not.toHaveBeenCalled();
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
