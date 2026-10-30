import { ConfigService } from '@nestjs/config';

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { ForgejoService } from './forgejo.service';
import { GithubService } from './github/github.service';
import { GitlabService } from './gitlab.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * Cross-adapter guard for the failure behind issue #1541.
 *
 * Every adapter's getAuthDetails/getGithubAuthDetails spreads the integration
 * lookup and defaults authMode, so it returns a truthy object even when the
 * organization has no integration of that platform at all. The
 * `if (!authDetail) throw` guard each getCloneParams carries therefore never
 * fires, and the method goes on to build a clone URL from a hardcoded SaaS
 * base — github.com, gitlab.com, bitbucket.org — with no usable token.
 *
 * That is exactly how a CLI review on a self-managed host ended up cloning
 * github.com. No adapter may hand back clone params it cannot authenticate.
 */
describe('getCloneParams with no integration connected', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const repository = {
        id: 'repo-1',
        name: 'repo',
        fullName: 'group/repo',
        defaultBranch: 'main',
    };

    const cfg = { get: jest.fn() } as unknown as ConfigService;

    /** No integration of any platform for this organization. */
    const integrationService = () => ({
        getPlatformAuthDetails: jest.fn().mockResolvedValue(undefined),
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
    });

    const adapters: Array<{ name: string; build: () => any }> = [
        {
            name: 'GitHub',
            build: () =>
                new GithubService(
                    integrationService() as any,
                    {} as any,
                    {} as any,
                    {} as any,
                    cfg,
                ),
        },
        {
            name: 'GitLab',
            build: () =>
                new GitlabService(
                    integrationService() as any,
                    {} as any,
                    {} as any,
                    cfg,
                    {} as any,
                ),
        },
        {
            name: 'Bitbucket Cloud',
            build: () =>
                new BitbucketCloudService(
                    integrationService() as any,
                    {} as any,
                    {} as any,
                    cfg,
                    {} as any,
                ),
        },
        {
            name: 'Bitbucket Data Center',
            build: () =>
                new BitbucketDataCenterService(
                    integrationService() as any,
                    {} as any,
                    {} as any,
                    cfg,
                    {} as any,
                ),
        },
        {
            name: 'Azure Repos',
            build: () =>
                // Extra slot vs the others: azureReposRequestHelper.
                new AzureReposService(
                    integrationService() as any,
                    {} as any,
                    {} as any,
                    {} as any,
                    cfg,
                ),
        },
    ];

    it.each(adapters)(
        '$name does not invent a SaaS clone URL',
        async ({ build }) => {
            let cloneParams: any = null;

            try {
                cloneParams = await build().getCloneParams({
                    repository,
                    organizationAndTeamData,
                });
            } catch {
                // Throwing is an acceptable answer; returning a usable-looking
                // URL is not.
                cloneParams = null;
            }

            expect(cloneParams).toBeNull();
        },
    );

    it.each(adapters)(
        '$name never returns an empty auth token',
        async ({ build }) => {
            let cloneParams: any = null;

            try {
                cloneParams = await build().getCloneParams({
                    repository,
                    organizationAndTeamData,
                });
            } catch {
                cloneParams = null;
            }

            // The empty token is what made #1541 silent: the clone was
            // attempted anonymously and only failed later, as "not found".
            expect(cloneParams?.auth?.token).not.toBe('');
        },
    );

    it('Forgejo rejects rather than resolving auth details', async () => {
        const service = new ForgejoService(
            integrationService() as any,
            {} as any,
            {} as any,
            cfg,
        );

        // Forgejo already returns null from getAuthDetails — pinned so the
        // spread pattern does not creep in here too.
        await expect(
            service.getAuthDetails(organizationAndTeamData),
        ).resolves.toBeNull();
    });
});
