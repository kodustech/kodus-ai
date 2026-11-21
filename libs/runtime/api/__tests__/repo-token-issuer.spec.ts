jest.mock('../../../ee/configs/environment/environment', () => ({ environment: {} }), { virtual: true });

import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { RepositoryDownloadTokenError } from '@libs/platform/infrastructure/adapters/services/github/repository-download-token';

import { repositoryAccessProblemOf } from '../domain/ports';
import { CodeManagementRepoTokenIssuer } from '../infrastructure/repo-token-issuer.adapter';

const input = { organizationId: 'org-a', teamId: 'team-a', repositoryId: '123', repositoryName: 'acme/shop' };

function setup(platform: PlatformType | null, issue = jest.fn().mockResolvedValue({ token: 'ghs_x', expiresAt: 'e' })) {
    const codeManagement = { getTypeIntegration: jest.fn().mockResolvedValue(platform) };
    return { issue, issuer: new CodeManagementRepoTokenIssuer(codeManagement as any, { issueRepositoryDownloadToken: issue }) };
}

describe('CodeManagementRepoTokenIssuer', () => {
    it('GitHub: the one-repo download token of that org and repository', async () => {
        const t = setup(PlatformType.GITHUB);
        await expect(t.issuer.issue(input)).resolves.toBe('ghs_x');
        expect(t.issue).toHaveBeenCalledWith({ organizationAndTeamData: { organizationId: 'org-a', teamId: 'team-a' }, repositoryId: '123' });
    });

    it('other platforms and orgs without integration answer 503', async () => {
        for (const p of [PlatformType.GITLAB, PlatformType.BITBUCKET, PlatformType.AZURE_REPOS, PlatformType.FORGEJO, null]) {
            const t = setup(p);
            await expect(t.issuer.issue(input)).rejects.toBeInstanceOf(ServiceUnavailableException);
            expect(t.issue).not.toHaveBeenCalled();
        }
    });

    it('PAT auth is 503, a widened token is 502, a platform error is 502 without its details', async () => {
        const pat = setup(PlatformType.GITHUB, jest.fn().mockRejectedValue(new RepositoryDownloadTokenError('unsupported_auth', 'PAT')));
        await expect(pat.issuer.issue(input)).rejects.toBeInstanceOf(ServiceUnavailableException);
        const wide = setup(PlatformType.GITHUB, jest.fn().mockRejectedValue(new RepositoryDownloadTokenError('unexpected_scope', 'x')));
        await expect(wide.issuer.issue(input)).rejects.toBeInstanceOf(BadGatewayException);
        const boom = setup(PlatformType.GITHUB, jest.fn().mockRejectedValue(new Error('secret request detail')));
        await expect(boom.issuer.issue(input)).rejects.toThrow('GitHub did not issue the repository download token');
    });

    // The trigger answers these on the PR instead of retrying: no retry changes them, an admin does.
    it('a PAT connection and a missing installation name the access problem an admin must fix, still as 503', async () => {
        for (const [reason, problem] of [
            ['unsupported_auth', 'pat_connection'],
            ['no_installation', 'repository_unreachable'],
        ] as const) {
            const t = setup(PlatformType.GITHUB, jest.fn().mockRejectedValue(new RepositoryDownloadTokenError(reason, 'x')));
            const error = await t.issuer.issue(input).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ServiceUnavailableException);
            expect(repositoryAccessProblemOf(error)).toBe(problem);
        }
        const boom = setup(PlatformType.GITHUB, jest.fn().mockRejectedValue(new Error('timeout')));
        expect(repositoryAccessProblemOf(await boom.issuer.issue(input).catch((e: unknown) => e))).toBeUndefined();
    });
});
