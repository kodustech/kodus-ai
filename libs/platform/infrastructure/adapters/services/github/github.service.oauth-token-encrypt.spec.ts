import { decrypt } from '@libs/common/utils/crypto';

import { GithubService } from './github.service';

/**
 * Token-at-rest encryption — the GitHub App installation flow stored
 * `installationAuthentication.token` in authDetails in clear, unlike the PAT
 * flow which encrypts. The token is a live credential; it must be encrypted at
 * rest so a DB read does not expose a usable credential.
 */
describe('GithubService.authenticateWithCodeOauth — encrypts the installation token', () => {
    it('persists the installation token encrypted, not in clear', async () => {
        const rawToken = 'ghs_live_installation_token_value';
        const svc: any = Object.create(GithubService.prototype);

        const appOctokit = {
            auth: jest.fn().mockResolvedValue({ token: rawToken }),
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

        svc.assertGithubOAuthEnv = jest.fn();
        svc.createOctokitInstance = jest.fn().mockReturnValue(appOctokit);
        svc.checkRepositoryPermissions = jest
            .fn()
            .mockResolvedValue({ success: true });
        svc.integrationService = { findOne: jest.fn().mockResolvedValue(null) };
        const handleIntegration = jest.fn().mockResolvedValue(undefined);
        svc.handleIntegration = handleIntegration;
        svc.findOneByOrganizationId = jest
            .fn()
            .mockResolvedValue({ installationStatus: 'SUCCESS' });

        const res = await svc.authenticateWithCodeOauth({
            code: '123',
            authMode: 'OAUTH',
            organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
        });

        expect(res.success).toBe(true);

        const persisted = handleIntegration.mock.calls[0][1];
        // Never the raw token at rest...
        expect(persisted.authToken).not.toBe(rawToken);
        expect(persisted.authToken).not.toContain(rawToken);
        // ...but decryptable back to it, like the PAT path.
        expect(decrypt(persisted.authToken)).toBe(rawToken);
    });
});
