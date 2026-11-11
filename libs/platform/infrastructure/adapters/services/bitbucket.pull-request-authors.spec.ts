import { IntegrationConfigKey } from '@libs/core/domain/enums';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';

import { BitbucketService } from './bitbucket.service';

/**
 * Recent pull request authors on Bitbucket Cloud come from the stored PRs:
 * listing them from the API cost one request per configured repository
 * against a 1,000 requests/hour per-user quota.
 */

const org = { organizationId: 'org-1', teamId: 'team-1' };

function build(host?: string) {
    const findPullRequestAuthorsOpenedSince = jest.fn().mockResolvedValue([
        { id: '{aaa}', name: 'Ana', username: 'ana' },
        { id: 'aaa', name: 'Ana', username: 'ana' },
        { id: 'bbb', name: '', username: 'bruno' },
    ]);
    const cloud = {
        findOneByOrganizationAndTeamDataAndConfigKey: jest
            .fn()
            .mockResolvedValue([{ id: 'repo-1' }, { id: 'repo-2' }]),
        getPullRequestAuthors: jest.fn(),
    };
    const dataCenter = {
        getPullRequestAuthors: jest.fn().mockResolvedValue([]),
    };
    const integrationService = {
        getPlatformAuthDetails: jest.fn().mockResolvedValue({ host }),
    };
    const hasStoredPullRequests = jest.fn().mockResolvedValue(true);
    const moduleRef = {
        get: jest.fn((token) =>
            token === PULL_REQUESTS_SERVICE_TOKEN
                ? { findPullRequestAuthorsOpenedSince, hasStoredPullRequests }
                : undefined,
        ),
    };
    const service = new BitbucketService(
        cloud as any,
        dataCenter as any,
        integrationService as any,
        {} as any,
        moduleRef as any,
    );
    return {
        service,
        cloud,
        dataCenter,
        findPullRequestAuthorsOpenedSince,
        hasStoredPullRequests,
    };
}

describe('BitbucketService.getPullRequestAuthors', () => {
    it('reads Cloud authors from stored PRs of the configured repositories, with no API call', async () => {
        const { service, cloud, findPullRequestAuthorsOpenedSince } = build();
        const before = Date.now();

        const authors = await service.getPullRequestAuthors({
            organizationAndTeamData: org,
        });

        expect(cloud.getPullRequestAuthors).not.toHaveBeenCalled();
        expect(
            cloud.findOneByOrganizationAndTeamDataAndConfigKey,
        ).toHaveBeenCalledWith(org, IntegrationConfigKey.REPOSITORIES);
        const [since, organizationId, repositoryIds] =
            findPullRequestAuthorsOpenedSince.mock.calls[0];
        expect(organizationId).toBe('org-1');
        expect(repositoryIds).toEqual(['repo-1', 'repo-2']);
        const days = (before - Date.parse(since)) / 86_400_000;
        expect(Math.round(days)).toBe(60);
        // braces stripped and deduplicated; a nameless author falls back to
        // the username
        expect(authors).toEqual([
            { id: 'aaa', name: 'Ana', type: 'user' },
            { id: 'bbb', name: 'bruno', type: 'user' },
        ]);
    });

    it('fails instead of answering an empty list when the stored PRs cannot be read', async () => {
        const { service, findPullRequestAuthorsOpenedSince } = build();
        findPullRequestAuthorsOpenedSince.mockRejectedValue(new Error('down'));

        await expect(
            service.getPullRequestAuthors({ organizationAndTeamData: org }),
        ).rejects.toThrow('down');
    });

    it('fails when no PR is stored yet for the configured repositories', async () => {
        const {
            service,
            findPullRequestAuthorsOpenedSince,
            hasStoredPullRequests,
        } = build();
        findPullRequestAuthorsOpenedSince.mockResolvedValue([]);
        hasStoredPullRequests.mockResolvedValue(false);

        await expect(
            service.getPullRequestAuthors({ organizationAndTeamData: org }),
        ).rejects.toThrow(/No pull requests stored yet/);
    });

    it('answers no authors when PRs are stored but none is recent', async () => {
        const { service, findPullRequestAuthorsOpenedSince } = build();
        findPullRequestAuthorsOpenedSince.mockResolvedValue([]);

        await expect(
            service.getPullRequestAuthors({ organizationAndTeamData: org }),
        ).resolves.toEqual([]);
    });

    // Guard, not a regression pin: Data Center is untouched and must stay so.
    it('leaves Data Center on its own implementation', async () => {
        const { service, dataCenter, findPullRequestAuthorsOpenedSince } =
            build('https://bitbucket.example.com');

        await service.getPullRequestAuthors({ organizationAndTeamData: org });

        expect(dataCenter.getPullRequestAuthors).toHaveBeenCalled();
        expect(findPullRequestAuthorsOpenedSince).not.toHaveBeenCalled();
    });
});
