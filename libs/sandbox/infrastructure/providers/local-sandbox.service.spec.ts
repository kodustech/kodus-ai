import { PlatformType } from '@libs/core/domain/enums';
import { LocalSandboxService } from './local-sandbox.service';

/**
 * buildAuthHeader is the git-over-HTTPS Authorization builder used when the
 * local sandbox clones a repo. The Bitbucket branch is the regression guard
 * for #1168: Atlassian API tokens (ATATT…) authenticate to git ONLY with the
 * literal username `x-bitbucket-api-token-auth`, NOT the account email/username
 * the REST API accepts. Getting this wrong yields a silent anonymous clone and
 * `fatal: could not read Username`.
 */
describe('LocalSandboxService.buildAuthHeader', () => {
    const service = new LocalSandboxService({} as any);
    // Private method — exercise it directly.
    const build = (platform: PlatformType, token: string, username?: string) =>
        (service as any).buildAuthHeader(platform, token, username) as string;

    const decode = (header: string) =>
        Buffer.from(header.replace('Authorization: Basic ', ''), 'base64').toString(
            'utf8',
        );

    it('uses x-access-token for GitHub', () => {
        expect(decode(build(PlatformType.GITHUB, 'ghtok'))).toBe(
            'x-access-token:ghtok',
        );
    });

    it('uses oauth2 for GitLab and Azure', () => {
        expect(decode(build(PlatformType.GITLAB, 'gltok'))).toBe('oauth2:gltok');
        expect(decode(build(PlatformType.AZURE_REPOS, 'aztok'))).toBe(
            'oauth2:aztok',
        );
    });

    describe('Bitbucket (#1168)', () => {
        it('uses x-bitbucket-api-token-auth for Atlassian API tokens (ATATT…), ignoring the stored email/username', () => {
            const header = build(
                PlatformType.BITBUCKET,
                'ATATT3xFfGF0token',
                'gabriel.malinosqui@kodus.io', // REST-API identity — must NOT be used for git
            );
            expect(decode(header)).toBe(
                'x-bitbucket-api-token-auth:ATATT3xFfGF0token',
            );
        });

        it('uses the account username for classic app passwords', () => {
            expect(
                decode(build(PlatformType.BITBUCKET, 'classicapppw', 'kodususer')),
            ).toBe('kodususer:classicapppw');
        });

        it('still works for an API token even when no username is provided', () => {
            expect(decode(build(PlatformType.BITBUCKET, 'ATATTabc'))).toBe(
                'x-bitbucket-api-token-auth:ATATTabc',
            );
        });

        it('throws for a classic app password with no username (cannot build valid git auth)', () => {
            expect(() => build(PlatformType.BITBUCKET, 'classicpw')).toThrow(
                /Bitbucket authentication requires/i,
            );
        });
    });
});
