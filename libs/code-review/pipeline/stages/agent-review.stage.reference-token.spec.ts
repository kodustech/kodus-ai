import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { AgentReviewStage } from './agent-review.stage';

/**
 * The clone token goes to readReference only when the reviewed repository is
 * on github.com: readReference calls api.github.com, and a token of another
 * host (another platform, or a GitHub Enterprise Server) has no business there.
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

const contextOn = (
    platformType: PlatformType,
    cloneUrl = 'https://github.com/acme-brewery/taproom.git',
) =>
    ({
        platformType,
        getFreshCloneParams: async () => ({
            authToken: 'clone-token',
            cloneUrl,
        }),
    }) as any;

describe('AgentReviewStage — token for readReference', () => {
    it('hands the clone token on a github.com review', async () => {
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

    it.each([
        'https://git.brewery.example/acme-brewery/taproom.git',
        'https://github.brewery.example/acme-brewery/taproom.git',
        'https://github.com.brewery.example/acme-brewery/taproom.git',
    ])(
        'hands no token on a GitHub Enterprise Server review (%s)',
        async (cloneUrl) => {
            await expect(
                (stage as any).resolveGitHubToken(
                    contextOn(PlatformType.GITHUB, cloneUrl),
                ),
            ).resolves.toBeUndefined();
        },
    );
});
