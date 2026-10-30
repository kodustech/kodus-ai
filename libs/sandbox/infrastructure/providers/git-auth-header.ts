import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

/**
 * The `Authorization` header git needs to clone over HTTPS with a provider
 * token. Shared by the local sandbox clone and the self-hosted doctor's test
 * clone so both authenticate exactly the same way.
 */
export function buildGitAuthHeader(
    platform: PlatformType,
    token: string,
    username?: string,
): string {
    switch (platform) {
        case PlatformType.GITHUB:
            return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
        case PlatformType.BITBUCKET: {
            // Bitbucket git-over-HTTPS auth differs from the REST API.
            // Atlassian API tokens (ATATT…, the scheme that replaces app
            // passwords) authenticate to git ONLY with the literal
            // username `x-bitbucket-api-token-auth` — the REST API accepts
            // <email>:<token>, but git rejects that pair (→ "could not
            // read Username"). Classic app passwords keep using the
            // Bitbucket account username. See #1168.
            const gitUsername = token.startsWith('ATATT')
                ? 'x-bitbucket-api-token-auth'
                : username;
            if (!gitUsername) {
                throw new Error(
                    'Bitbucket authentication requires a username (app password) or an Atlassian API token, but neither was provided.',
                );
            }
            return `Authorization: Basic ${Buffer.from(`${gitUsername}:${token}`).toString('base64')}`;
        }
        case PlatformType.GITLAB:
        case PlatformType.AZURE_REPOS:
            return `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
        default:
            return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }
}
