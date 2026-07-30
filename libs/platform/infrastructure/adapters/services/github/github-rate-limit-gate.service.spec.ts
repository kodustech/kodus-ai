import { PlatformType } from '@libs/core/domain/enums';

import { GitHubRateLimitGateService } from './github-rate-limit-gate.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * Regression coverage for issue #1541.
 *
 * The CLI job processor used to hand this gate `inferredPlatform ?? GITHUB`.
 * For any self-managed host the CLI cannot recognize, that meant claiming
 * GitHub for organizations that may have no GitHub integration at all — and
 * the gate would then probe the GitHub API on their behalf. The platform is
 * now optional, and an unknown one must pass through untouched.
 */
describe('GitHubRateLimitGateService.check (platform gating)', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    let gate: GitHubRateLimitGateService;
    let cacheService: { getFromCache: jest.Mock; addToCache: jest.Mock };
    let githubService: Record<string, jest.Mock>;

    beforeEach(() => {
        cacheService = {
            getFromCache: jest.fn().mockResolvedValue(undefined),
            addToCache: jest.fn().mockResolvedValue(undefined),
        };
        githubService = {
            getGithubAuthDetails: jest.fn().mockResolvedValue(undefined),
        };

        gate = new GitHubRateLimitGateService(
            githubService as any,
            cacheService as any,
        );
    });

    it('does not touch the GitHub bucket when the platform is unknown', async () => {
        await expect(
            gate.check(organizationAndTeamData, undefined),
        ).resolves.toBeUndefined();

        expect(cacheService.getFromCache).not.toHaveBeenCalled();
    });

    it.each([
        PlatformType.GITLAB,
        PlatformType.BITBUCKET,
        PlatformType.AZURE_REPOS,
        PlatformType.FORGEJO,
    ])('passes %s through without probing GitHub', async (platform) => {
        await expect(
            gate.check(organizationAndTeamData, platform),
        ).resolves.toBeUndefined();

        expect(cacheService.getFromCache).not.toHaveBeenCalled();
    });

    it('still checks the bucket for GitHub', async () => {
        await gate.check(organizationAndTeamData, PlatformType.GITHUB);

        expect(cacheService.getFromCache).toHaveBeenCalled();
    });
});
