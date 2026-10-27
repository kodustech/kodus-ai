jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

/**
 * #2037: the PR diff as it stood at an earlier head, so a rebase can be
 * compared with what was already reviewed.
 */
describe('GithubService.getPullRequestFilesAtCommit', () => {
    const makeService = (compareCommitsWithBasehead: jest.Mock) => {
        const service = new GithubService(
            { findOne: jest.fn() } as any,
            {} as any,
            { createOrUpdateConfig: jest.fn() } as any,
            {
                getFromCache: jest.fn().mockResolvedValue(null),
                addToCache: jest.fn(),
            } as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'acme',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            repos: { compareCommitsWithBasehead },
        });
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (service as any).logger = logger;
        return { service, logger };
    };

    const read = (service: GithubService) =>
        service.getPullRequestFilesAtCommit({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: '1', name: 'repo' },
            prNumber: 7,
            baseBranch: 'main',
            headSha: 'old-head',
        });

    it('compares the base branch with the earlier head through their merge base', async () => {
        const compare = jest.fn().mockResolvedValue({
            data: {
                files: [
                    {
                        filename: 'src/b.ts',
                        previous_filename: 'src/a.ts',
                        status: 'renamed',
                        additions: 1,
                        deletions: 0,
                        changes: 1,
                        patch: '@@ -1 +1,2 @@\n a\n+b',
                    },
                ],
            },
        });
        const { service } = makeService(compare);

        const files = await read(service);

        expect(compare).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'acme',
                repo: 'repo',
                basehead: 'main...old-head',
            }),
        );
        expect(files).toEqual([
            {
                filename: 'src/b.ts',
                previous_filename: 'src/a.ts',
                status: 'renamed',
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: '@@ -1 +1,2 @@\n a\n+b',
            },
        ]);
    });

    it('returns null when the compare hit the 300-file cap, since files may be missing', async () => {
        const files = Array.from({ length: 300 }, (_, i) => ({
            filename: `f${i}.ts`,
            status: 'modified',
            patch: '@@ -1 +1 @@\n-a\n+b',
        }));
        const { service, logger } = makeService(
            jest.fn().mockResolvedValue({ data: { files } }),
        );

        await expect(read(service)).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    reason: 'compare_file_cap',
                }),
            }),
        );
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

    it('returns null and warns when the earlier head is gone', async () => {
        const { service, logger } = makeService(
            jest
                .fn()
                .mockRejectedValue(
                    Object.assign(new Error('Not Found'), { status: 404 }),
                ),
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
