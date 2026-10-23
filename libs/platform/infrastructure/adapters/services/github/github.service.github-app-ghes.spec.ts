import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GithubService } from './github.service';

/**
 * GitHub App on GitHub Enterprise Server: with `API_GITHUB_APP_HOST` set, the
 * App client, installation tokens and the API clients of App installs must go
 * to that host instead of api.github.com.
 */
describe('GithubService — GitHub App on GitHub Enterprise Server', () => {
    const organizationAndTeamData = { organizationId: 'o1', teamId: 't1' };

    function createService(env: Record<string, string | undefined>): any {
        const svc: any = Object.create(GithubService.prototype);
        svc.configService = { get: (key: string) => env[key] };
        svc.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
        return svc;
    }

    const appEnv = {
        API_GITHUB_APP_ID: '1',
        API_GITHUB_PRIVATE_KEY: 'test-private-key',
        GLOBAL_GITHUB_CLIENT_ID: 'client-id',
        API_GITHUB_CLIENT_SECRET: 'client-secret',
    };

    describe('App client', () => {
        it('targets the GHES REST API when API_GITHUB_APP_HOST is set', () => {
            const svc = createService({
                ...appEnv,
                API_GITHUB_APP_HOST: 'ghe.example.com/',
            });

            const octokit = svc.createOctokitInstance();

            expect(octokit.request.endpoint.DEFAULTS.baseUrl).toBe(
                'https://ghe.example.com/api/v3',
            );
        });

        it('stays on api.github.com without API_GITHUB_APP_HOST', () => {
            const svc = createService(appEnv);

            const octokit = svc.createOctokitInstance();

            expect(octokit.request.endpoint.DEFAULTS.baseUrl).toBe(
                'https://api.github.com',
            );
        });
    });

    describe('installation', () => {
        it('stores the App host with a new installation', async () => {
            const svc = createService({
                ...appEnv,
                API_GITHUB_APP_HOST: 'https://ghe.example.com',
            });
            svc.assertGithubOAuthEnv = jest.fn();
            svc.createOctokitInstance = jest.fn().mockReturnValue({
                auth: jest.fn().mockResolvedValue({ token: 'ghs_token' }),
                rest: {
                    apps: {
                        getInstallation: jest.fn().mockResolvedValue({
                            data: {
                                account: { login: 'acme' },
                                target_type: 'Organization',
                            },
                        }),
                    },
                },
            });
            svc.checkRepositoryPermissions = jest
                .fn()
                .mockResolvedValue({ success: true });
            svc.integrationService = {
                findOne: jest.fn().mockResolvedValue(null),
            };
            const handleIntegration = jest.fn().mockResolvedValue(undefined);
            svc.handleIntegration = handleIntegration;
            svc.findOneByOrganizationId = jest
                .fn()
                .mockResolvedValue({ installationStatus: 'SUCCESS' });

            await svc.authenticateWithCodeOauth({
                code: '123',
                authMode: AuthMode.OAUTH,
                organizationAndTeamData,
            });

            expect(handleIntegration.mock.calls[0][1].host).toBe(
                'https://ghe.example.com',
            );
        });

        it('gives an App install saved without a host the App host', async () => {
            const svc = createService({
                API_GITHUB_APP_HOST: 'https://ghe.example.com',
            });
            svc.integrationService = {
                getPlatformAuthDetails: jest.fn().mockResolvedValue({
                    authMode: AuthMode.OAUTH,
                    installationId: '42',
                }),
            };

            const details = await svc.getGithubAuthDetails(
                organizationAndTeamData,
            );

            expect(details.host).toBe('https://ghe.example.com');
        });

        it('leaves PAT integrations and stored hosts alone', async () => {
            const svc = createService({
                API_GITHUB_APP_HOST: 'https://ghe.example.com',
            });
            svc.integrationService = {
                getPlatformAuthDetails: jest
                    .fn()
                    .mockResolvedValueOnce({ authMode: AuthMode.TOKEN })
                    .mockResolvedValueOnce({
                        authMode: AuthMode.OAUTH,
                        installationId: '42',
                        host: 'https://other.example.com',
                    }),
            };

            const pat = await svc.getGithubAuthDetails(organizationAndTeamData);
            const app = await svc.getGithubAuthDetails(organizationAndTeamData);

            expect(pat.host).toBeUndefined();
            expect(app.host).toBe('https://other.example.com');
        });
    });

    describe('API clients of an App install', () => {
        let fetchSpy: jest.SpyInstance;

        beforeEach(() => {
            fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ data: { viewer: {} } }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        });

        afterEach(() => {
            fetchSpy.mockRestore();
        });

        it('sends GraphQL calls to <host>/api/graphql', async () => {
            const svc = createService({});
            svc.getGithubAuthDetails = jest.fn().mockResolvedValue({
                authMode: AuthMode.OAUTH,
                installationId: '42',
                host: 'https://ghe.example.com',
            });
            svc.getInstallationAuthentication = jest
                .fn()
                .mockResolvedValue({ token: 'ghs_token' });

            const graphqlClient = await svc.instanceGraphQL(
                organizationAndTeamData,
            );
            await graphqlClient('query { viewer { login } }');

            expect(String(fetchSpy.mock.calls[0][0])).toBe(
                'https://ghe.example.com/api/graphql',
            );
        });
    });
});
