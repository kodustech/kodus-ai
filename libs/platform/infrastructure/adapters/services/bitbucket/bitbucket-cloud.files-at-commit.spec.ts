jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { BitbucketCloudService } from './bitbucket-cloud.service';

/**
 * #2037: the PR diff as it stood at an earlier head, so a rebase can be
 * compared with what was already reviewed.
 */
describe('BitbucketCloudService.getPullRequestFilesAtCommit', () => {
    const makeService = (getDiff: jest.Mock) => {
        const service = new BitbucketCloudService(
            { findOne: jest.fn() } as any,
            { createOrUpdateConfig: jest.fn() } as any,
            { findOne: jest.fn() } as any,
            { get: jest.fn() } as any,
        );
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            token: 't',
        });
        jest.spyOn(service as any, 'getRepoById').mockResolvedValue({
            id: 'repo-1',
            workspaceId: 'ws-1',
        });
        jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
            pullrequests: {
                get: jest.fn().mockResolvedValue({
                    data: { destination: { commit: { hash: 'main-tip' } } },
                }),
            },
            commits: { getDiff },
        });
        const logger = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        };
        (service as any).logger = logger;
        return { service, logger };
    };

    const read = (service: BitbucketCloudService) =>
        service.getPullRequestFilesAtCommit({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: 'repo-1', name: 'api' },
            prNumber: 7,
            baseBranch: 'main',
            headSha: 'old-head',
        });

    it('reads the topic diff of the earlier head against the destination, split per file', async () => {
        const getDiff = jest.fn().mockResolvedValue({
            data: [
                'diff --git a/src/a.ts b/src/a.ts',
                '--- a/src/a.ts',
                '+++ b/src/a.ts',
                '@@ -1 +1 @@',
                '-a',
                '+b',
                '',
            ].join('\n'),
        });
        const { service } = makeService(getDiff);

        const files = await read(service);

        expect(getDiff).toHaveBeenCalledWith({
            repo_slug: '{repo-1}',
            workspace: '{ws-1}',
            spec: 'old-head..main-tip',
        });
        expect(files).toEqual([
            expect.objectContaining({
                filename: 'src/a.ts',
                status: 'modified',
                patch: '@@ -1 +1 @@\n-a\n+b',
                additions: 1,
                deletions: 1,
                changes: 2,
            }),
        ]);
    });

    it('lets a rate limit through, so the review is not rerun in full', async () => {
        const { service } = makeService(
            jest
                .fn()
                .mockRejectedValue(
                    Object.assign(new Error('Too Many Requests'), {
                        status: 429,
                    }),
                ),
        );

        await expect(read(service)).rejects.toMatchObject({ status: 429 });
    });

    it('returns null and warns when the earlier head cannot be read', async () => {
        const { service, logger } = makeService(
            jest.fn().mockRejectedValue(new Error('Not Found')),
        );

        await expect(read(service)).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    prNumber: 7,
                    headSha: 'old-head',
                    reason: 'compare_failed',
                }),
            }),
        );
    });
});
