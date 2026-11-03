import {
    BadRequestException,
    InternalServerErrorException,
} from '@nestjs/common';

import { GithubService } from './github.service';
import {
    githubUserAuthorizationUrl,
    INSTALLATION_STATE_TTL_MS,
    InstallationAuthorizationError,
    openInstallationState,
    sealInstallationState,
} from './installation-authorization';

/**
 * A GitHub App installation id is a GitHub-wide integer and the App's own key
 * mints a token for any installation of the App. Linking one to a Kodus team
 * therefore needs GitHub's word that the person linking can see it: the code
 * from GitHub's user authorization of the App, under a state Kodus issued to
 * that user for that installation.
 */
describe('GitHub installation linking', () => {
    const ORG = 'org-1';
    const USER = 'user-1';
    const INSTALLATION = '4242';

    const state = (over: Partial<Record<string, string>> = {}) =>
        sealInstallationState({
            installationId: INSTALLATION,
            userId: USER,
            organizationId: ORG,
            ...over,
        });

    const setup = (opts: {
        userInstallations?: number[];
        linkedTo?: string | string[];
        codeAccepted?: boolean;
    }) => {
        const svc: any = Object.create(GithubService.prototype);
        const appAuth = jest.fn(async (args: any) => {
            if (args.type === 'oauth-user') {
                if (opts.codeAccepted === false) {
                    throw new Error('bad_verification_code');
                }
                return { token: 'ghu_user_token' };
            }
            return { token: 'ghs_installation_token', installationId: 4242 };
        });
        const appOctokit = {
            auth: appAuth,
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
        };
        const paginate = jest
            .fn()
            .mockResolvedValue(
                (opts.userInstallations ?? [4242]).map((id) => ({ id })),
            );
        svc.assertGithubOAuthEnv = jest.fn();
        svc.configService = { get: () => 'https://app.example.test/' };
        svc.createOctokitInstance = jest.fn().mockReturnValue(appOctokit);
        svc.createUserOctokit = jest.fn().mockReturnValue({ paginate });
        const linkedTo = [opts.linkedTo ?? []].flat();
        svc.authIntegrationService = {
            find: jest.fn(async (filter: any) =>
                typeof filter.authDetails.installationId === 'number'
                    ? linkedTo.map((uuid) => ({ organization: { uuid } }))
                    : [],
            ),
        };
        svc.checkRepositoryPermissions = jest
            .fn()
            .mockResolvedValue({ success: true });
        svc.integrationService = { findOne: jest.fn().mockResolvedValue(null) };
        svc.handleIntegration = jest.fn().mockResolvedValue(undefined);
        svc.findOneByOrganizationId = jest
            .fn()
            .mockResolvedValue({ installationStatus: 'SUCCESS' });
        return { svc, appAuth, paginate };
    };

    const link = (svc: any, over: Record<string, unknown> = {}) =>
        svc.authenticateWithCodeOauth({
            code: INSTALLATION,
            authMode: 'OAUTH',
            userId: USER,
            githubCode: 'gh-code',
            githubState: state(),
            organizationAndTeamData: { organizationId: ORG, teamId: 't1' },
            ...over,
        });

    const mintedInstallationToken = (appAuth: jest.Mock) =>
        appAuth.mock.calls.some(([a]) => a.type === 'installation');

    it('links an installation the user can see on GitHub', async () => {
        const { svc, appAuth, paginate } = setup({});
        const res = await link(svc);
        expect(res.success).toBe(true);
        expect(appAuth).toHaveBeenCalledWith({
            type: 'oauth-user',
            code: 'gh-code',
            redirectUrl:
                'https://app.example.test/api/auth/callback/github/installation',
        });
        expect(svc.createUserOctokit).toHaveBeenCalledWith('ghu_user_token');
        expect(paginate).toHaveBeenCalledWith('GET /user/installations', {
            per_page: 100,
        });
        expect(svc.handleIntegration).toHaveBeenCalled();
    });

    const MISSING = 'The GitHub authorization is missing or invalid';
    const ANOTHER =
        'The GitHub authorization was issued for another connection';

    // Every failure ends as a BadRequestException, so each case names the
    // check that refused it: the type alone passes with any check removed.
    it.each([
        [
            'no GitHub authorization at all',
            { githubCode: undefined, githubState: undefined },
            MISSING,
        ],
        ['no code', { githubCode: undefined }, MISSING],
        ['a code that is not text', { githubCode: 123 }, MISSING],
        ['a code that is an object', { githubCode: { a: 1 } }, MISSING],
        ['a forged state', { githubState: 'eyJ4IjoxfQ.forged' }, MISSING],
        [
            'an expired state',
            {
                githubState: sealInstallationState(
                    {
                        installationId: INSTALLATION,
                        userId: USER,
                        organizationId: ORG,
                    },
                    Date.now() - INSTALLATION_STATE_TTL_MS - 1,
                ),
            },
            'The GitHub authorization expired',
        ],
        [
            'a state for another installation',
            { githubState: state({ installationId: '999' }) },
            ANOTHER,
        ],
        [
            'a state issued to another user',
            { githubState: state({ userId: 'user-2' }) },
            ANOTHER,
        ],
        [
            'a state for another organization',
            { githubState: state({ organizationId: 'org-2' }) },
            ANOTHER,
        ],
        [
            'a non-numeric installation id, even under a state sealed for it',
            {
                code: '42; drop',
                githubState: state({ installationId: '42; drop' }),
            },
            'Invalid GitHub installation id.',
        ],
    ])(
        'refuses %s, before any installation token',
        async (_, over, message) => {
            const { svc, appAuth } = setup({});
            const refusal = link(svc, over);
            await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
            await expect(refusal).rejects.toThrow(message);
            expect(mintedInstallationToken(appAuth)).toBe(false);
            expect(svc.handleIntegration).not.toHaveBeenCalled();
        },
    );

    it('reports a missing API_CRYPTO_KEY instead of calling the state invalid', async () => {
        const { svc } = setup({});
        const params = {
            code: INSTALLATION,
            userId: USER,
            githubCode: 'gh-code',
            githubState: state(),
            organizationAndTeamData: { organizationId: ORG, teamId: 't1' },
        };
        const previous = process.env.API_CRYPTO_KEY;
        delete process.env.API_CRYPTO_KEY;
        try {
            await expect(svc.authenticateWithCodeOauth(params)).rejects.toThrow(
                'API_CRYPTO_KEY',
            );
        } finally {
            process.env.API_CRYPTO_KEY = previous;
        }
        expect(svc.handleIntegration).not.toHaveBeenCalled();
    });

    it('links an installation among the several the user can see', async () => {
        const { svc } = setup({ userInstallations: [1, 4242, 7] });
        await expect(link(svc)).resolves.toEqual(
            expect.objectContaining({ success: true }),
        );
    });

    it('looks for the active links of the installation, as a number and as text', async () => {
        const { svc } = setup({});
        await link(svc);
        expect(svc.authIntegrationService.find).toHaveBeenCalledWith({
            authDetails: { installationId: 4242 },
            status: true,
        });
        expect(svc.authIntegrationService.find).toHaveBeenCalledWith({
            authDetails: { installationId: INSTALLATION },
            status: true,
        });
    });

    it('ignores a link without an organization', async () => {
        const { svc } = setup({});
        svc.authIntegrationService.find = jest.fn(async () => [
            { organization: null },
            null,
        ]);
        await expect(link(svc)).resolves.toEqual(
            expect.objectContaining({ success: true }),
        );
    });

    it('refuses an installation the user cannot see on GitHub', async () => {
        const { svc, appAuth } = setup({ userInstallations: [1, 2] });
        await expect(link(svc)).rejects.toThrow(
            'cannot access this installation',
        );
        expect(mintedInstallationToken(appAuth)).toBe(false);
        expect(svc.handleIntegration).not.toHaveBeenCalled();
    });

    it('refuses when GitHub rejects the code', async () => {
        const { svc } = setup({ codeAccepted: false });
        await expect(link(svc)).rejects.toThrow(
            'GitHub did not accept the authorization',
        );
        expect(svc.handleIntegration).not.toHaveBeenCalled();
    });

    it('refuses an installation already linked to another organization', async () => {
        const { svc } = setup({ linkedTo: 'org-2' });
        await expect(link(svc)).rejects.toThrow(
            'already connected to another Kodus organization',
        );
        expect(svc.handleIntegration).not.toHaveBeenCalled();
    });

    it('refuses an installation linked to the same and to another organization', async () => {
        const { svc } = setup({ linkedTo: [ORG, 'org-2'] });
        await expect(link(svc)).rejects.toThrow(
            'already connected to another Kodus organization',
        );
        expect(svc.handleIntegration).not.toHaveBeenCalled();
    });

    it('refuses the link when the existing links cannot be read', async () => {
        const { svc } = setup({});
        svc.authIntegrationService.find = jest
            .fn()
            .mockRejectedValue(new Error('connection terminated'));
        await expect(link(svc)).rejects.toThrow();
        expect(svc.handleIntegration).not.toHaveBeenCalled();
    });

    it('relinks an installation already linked to the same organization', async () => {
        const { svc } = setup({ linkedTo: ORG });
        await expect(link(svc)).resolves.toEqual(
            expect.objectContaining({ success: true }),
        );
    });

    it("logs a failed link without the token or GitHub's code and state", async () => {
        const svc: any = Object.create(GithubService.prototype);
        const error = jest.fn();
        svc.logger = { error };
        svc.authenticateWithCodeOauth = jest
            .fn()
            .mockRejectedValue(new Error('GitHub refused'));
        svc.authenticateWithToken = svc.authenticateWithCodeOauth;

        for (const authMode of ['oauth', 'token']) {
            await expect(
                svc.createAuthIntegration({
                    authMode,
                    code: INSTALLATION,
                    token: 'ghp_secret_pat',
                    githubCode: 'gh-oauth-code',
                    githubState: 'sealed.state',
                    organizationAndTeamData: {
                        organizationId: ORG,
                        teamId: 't1',
                    },
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        }

        const logged = JSON.stringify(
            error.mock.calls.map(([e]) => e.metadata),
        );
        expect(logged).not.toContain('ghp_secret_pat');
        expect(logged).not.toContain('gh-oauth-code');
        expect(logged).not.toContain('sealed.state');
        expect(error.mock.calls[0][0].metadata).toEqual({
            organizationAndTeamData: { organizationId: ORG, teamId: 't1' },
            authMode: 'oauth',
            host: undefined,
            installationId: INSTALLATION,
        });
    });

    describe('getInstallationAuthorizationUrl', () => {
        it("returns GitHub's authorization page with a state for the user", () => {
            const svc: any = Object.create(GithubService.prototype);
            svc.assertGithubOAuthEnv = jest.fn();
            svc.configService = {
                get: (key: string) =>
                    ({
                        GLOBAL_GITHUB_CLIENT_ID: 'Iv1.client',
                        API_FRONTEND_URL: 'https://app.example.test',
                    })[key],
            };
            const { url } = svc.getInstallationAuthorizationUrl({
                installationId: INSTALLATION,
                userId: USER,
                organizationId: ORG,
            });
            const parsed = new URL(url);
            expect(parsed.origin + parsed.pathname).toBe(
                'https://github.com/login/oauth/authorize',
            );
            expect(parsed.searchParams.get('client_id')).toBe('Iv1.client');
            // Never the App's first callback URL, which is the sign-in one.
            expect(parsed.searchParams.get('redirect_uri')).toBe(
                'https://app.example.test/api/auth/callback/github/installation',
            );
            expect(
                openInstallationState(parsed.searchParams.get('state')),
            ).toEqual({
                installationId: INSTALLATION,
                userId: USER,
                organizationId: ORG,
            });
        });

        it('falls back to NEXTAUTH_URL, which self-hosted installs set', () => {
            const svc: any = Object.create(GithubService.prototype);
            svc.assertGithubOAuthEnv = jest.fn();
            svc.configService = {
                get: (key: string) =>
                    ({
                        GLOBAL_GITHUB_CLIENT_ID: 'Iv1.client',
                        NEXTAUTH_URL: 'https://kodus-web.example.test',
                    })[key],
            };
            const { url } = svc.getInstallationAuthorizationUrl({
                installationId: INSTALLATION,
                userId: USER,
                organizationId: ORG,
            });
            expect(new URL(url).searchParams.get('redirect_uri')).toBe(
                'https://kodus-web.example.test/api/auth/callback/github/installation',
            );
        });

        it('reports a missing web URL as a server error, not a bad request', () => {
            const svc: any = Object.create(GithubService.prototype);
            svc.assertGithubOAuthEnv = jest.fn();
            svc.configService = { get: () => undefined };
            expect(() =>
                svc.getInstallationAuthorizationUrl({
                    installationId: INSTALLATION,
                    userId: USER,
                    organizationId: ORG,
                }),
            ).toThrow(InternalServerErrorException);
        });

        it('refuses an installation id that is not a number', () => {
            const svc: any = Object.create(GithubService.prototype);
            svc.assertGithubOAuthEnv = jest.fn();
            expect(() =>
                svc.getInstallationAuthorizationUrl({
                    installationId: '../x',
                    userId: USER,
                    organizationId: ORG,
                }),
            ).toThrow(BadRequestException);
        });
    });

    describe('installation state', () => {
        it('expires', () => {
            const sealed = sealInstallationState(
                {
                    installationId: INSTALLATION,
                    userId: USER,
                    organizationId: ORG,
                },
                0,
            );
            expect(() =>
                openInstallationState(sealed, INSTALLATION_STATE_TTL_MS + 1),
            ).toThrow('expired');
        });

        it('rejects a payload changed after sealing', () => {
            const [, signature] = state().split('.');
            const forged = Buffer.from(
                JSON.stringify({
                    installationId: '999',
                    userId: USER,
                    organizationId: ORG,
                    expiresAt: Date.now() + 60_000,
                }),
            ).toString('base64url');
            expect(() =>
                openInstallationState(`${forged}.${signature}`),
            ).toThrow('invalid');
        });

        // A user mid-authorization during the deploy holds a state sealed in
        // the earlier format (fields at the top level), still validly signed.
        it('refuses a state in the earlier format as invalid, not with a crash', () => {
            const { createHmac, hkdfSync } = jest.requireActual(
                'node:crypto',
            ) as typeof import('node:crypto');
            const key = Buffer.from(
                hkdfSync(
                    'sha256',
                    Buffer.from(process.env.API_CRYPTO_KEY ?? '', 'hex'),
                    Buffer.alloc(0),
                    'kodus/github-installation-authorization/v1',
                    32,
                ),
            );
            const data = Buffer.from(
                JSON.stringify({
                    installationId: INSTALLATION,
                    userId: USER,
                    organizationId: ORG,
                    expiresAt: Date.now() + 60_000,
                }),
            ).toString('base64url');
            const signature = createHmac('sha256', key)
                .update(data)
                .digest('base64url');

            expect(() => openInstallationState(`${data}.${signature}`)).toThrow(
                InstallationAuthorizationError,
            );
        });

        it('builds the authorization URL with an encoded state', () => {
            const url = new URL(
                githubUserAuthorizationUrl(
                    'Iv1.c',
                    'a.b+c',
                    'https://x.test/github-integration',
                ),
            );
            expect(url.searchParams.get('state')).toBe('a.b+c');
            expect(url.searchParams.get('redirect_uri')).toBe(
                'https://x.test/github-integration',
            );
        });
    });
});
