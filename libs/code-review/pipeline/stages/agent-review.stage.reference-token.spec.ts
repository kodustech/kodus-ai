import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { AgentReviewStage } from './agent-review.stage';

/**
 * The clone token goes to readReference only when the reviewed repository is
 * on GitHub: readReference calls api.github.com, and another host's token has
 * no business there.
 */
const stage = new AgentReviewStage(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
);

const contextOn = (platformType: PlatformType) =>
    ({
        platformType,
        getFreshCloneParams: async () => ({ authToken: 'clone-token' }),
    }) as any;

describe('AgentReviewStage — token for readReference', () => {
    it('hands the clone token on a GitHub review', async () => {
        await expect(
            (stage as any).resolveGitHubToken(contextOn(PlatformType.GITHUB)),
        ).resolves.toBe('clone-token');
    });

    it.each([
        PlatformType.GITLAB,
        PlatformType.BITBUCKET,
        PlatformType.AZURE_REPOS,
    ])('hands no token on a %s review', async (platformType) => {
        await expect(
            (stage as any).resolveGitHubToken(contextOn(platformType)),
        ).resolves.toBeUndefined();
    });
});
