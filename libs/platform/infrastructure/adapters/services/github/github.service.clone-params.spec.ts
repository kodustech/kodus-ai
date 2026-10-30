import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * Regression coverage for issue #1541.
 *
 * When an organization has NO GitHub integration, getCloneParams must not
 * hand back a usable-looking github.com clone URL. It used to: the spread of
 * an undefined auth detail produced a truthy `{ authMode: 'oauth' }`, which
 * slipped past the `!githubAuthDetail` guard, and `decrypt(undefined)`
 * returns '' rather than throwing — so the method happily built
 * `https://github.com/<fullName>` with an empty token. Callers then cloned
 * from the wrong host entirely.
 */
describe('GithubService.getCloneParams (no GitHub integration)', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const repository = {
        id: '0',
        defaultBranch: 'main',
        fullName: 'group/repo',
        name: 'repo',
    };

    let service: GithubService;
    let integrationService: { getPlatformAuthDetails: jest.Mock };

    beforeEach(() => {
        integrationService = {
            // No GitHub integration connected for this organization.
            getPlatformAuthDetails: jest.fn().mockResolvedValue(undefined),
        };

        service = new GithubService(
            integrationService as any,
            {} as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
    });

    it('still returns a truthy auth detail (61 callers rely on it)', async () => {
        // Documents why getCloneParams cannot rely on a `!githubAuthDetail`
        // check: the spread of an undefined lookup plus the authMode default
        // always produces an object. Tightening this method itself would
        // change the failure mode of every caller that reads a field off it
        // without a guard, so the assertion lives in getCloneParams instead.
        await expect(
            service.getGithubAuthDetails(organizationAndTeamData),
        ).resolves.toEqual({ authMode: 'oauth' });
    });

    it('does not build a github.com clone URL when there is no integration', async () => {
        const cloneParams = await service.getCloneParams({
            repository,
            organizationAndTeamData,
        });

        expect(cloneParams).toBeNull();
    });

    it('never returns clone params carrying an empty auth token', async () => {
        const cloneParams = await service.getCloneParams({
            repository,
            organizationAndTeamData,
        });

        // The empty token is what made the failure silent: the clone was
        // attempted anonymously against github.com and only failed later,
        // as "repository not found".
        expect(cloneParams?.auth?.token).not.toBe('');
    });
});
