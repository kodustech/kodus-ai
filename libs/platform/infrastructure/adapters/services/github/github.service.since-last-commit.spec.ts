jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

/**
 * #2268: compare lists at most 300 files and cannot page them, so after the
 * base branch is merged into the PR the PR's own files can be cut off.
 */
describe('GithubService.getChangedFilesSinceLastCommit', () => {
    const file = (filename: string) => ({
        filename,
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: '@@ -1 +1 @@\n-a\n+b',
    });

    const makeService = (compareFiles: ReturnType<typeof file>[]) => {
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
        const listCommits = jest.fn();
        const listFiles = jest.fn();
        const paginate = jest.fn(async (endpoint: jest.Mock) =>
            endpoint === listCommits
                ? [
                      {
                          sha: 'reviewed-sha',
                          commit: { author: { date: '2026-01-01' } },
                      },
                      {
                          sha: 'head-sha',
                          commit: { author: { date: '2026-01-02' } },
                      },
                  ]
                : [{ filename: 'zz/own.ts' }],
        );
        const compareCommitsWithBasehead = jest
            .fn()
            .mockResolvedValue({ data: { files: compareFiles } });
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'acme',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            paginate,
            pulls: { listCommits, listFiles },
            repos: { compareCommitsWithBasehead },
        });
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (service as any).logger = logger;
        return { service, logger, compareCommitsWithBasehead };
    };

    const read = (service: GithubService, keepRemovedFiles?: boolean) =>
        service.getChangedFilesSinceLastCommit({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: '1', name: 'repo' },
            prNumber: 7,
            lastCommit: { sha: 'reviewed-sha' },
            ...(keepRemovedFiles ? { keepRemovedFiles } : {}),
        });

    it('keeps the compare files that belong to the PR', async () => {
        const { service, compareCommitsWithBasehead } = makeService([
            file('merged/a.ts'),
            file('zz/own.ts'),
        ]);

        const files = await read(service);

        // From the last reviewed commit to the PR head, not the base branch.
        expect(compareCommitsWithBasehead).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'repo',
            basehead: 'reviewed-sha...head-sha',
        });

        expect(files.map((f: { filename: string }) => f.filename)).toEqual([
            'zz/own.ts',
        ]);
    });

    it('returns [] when no compare file belongs to the PR', async () => {
        const { service } = makeService([file('merged/a.ts')]);

        await expect(read(service)).resolves.toEqual([]);
    });

    it('returns null when compare hits its 300-file cap', async () => {
        const merged = Array.from({ length: 300 }, (_, i) =>
            file(`merged/f${i}.ts`),
        );
        const { service, logger } = makeService(merged);

        await expect(read(service)).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    reason: 'compare_file_cap',
                }),
            }),
        );
    });

    // A file the PR added and a later push deleted: the PR's file list no
    // longer names it, but the diff since the review shows it removed.
    describe('a file deleted since the review that the PR no longer lists', () => {
        const gone = { ...file('src/new-in-pr.ts'), status: 'removed' };

        it('is kept, as removed, when the caller asks for removed files', async () => {
            const { service } = makeService([gone, file('zz/own.ts')]);

            const files = await read(service, true);

            expect(
                files.map((f: { filename: string; status: string }) => [
                    f.filename,
                    f.status,
                ]),
            ).toEqual([
                ['src/new-in-pr.ts', 'removed'],
                ['zz/own.ts', 'modified'],
            ]);
        });

        it('is left out otherwise, with the other files of a merge', async () => {
            const { service } = makeService([
                gone,
                file('merged/a.ts'),
                file('zz/own.ts'),
            ]);

            const files = await read(service);

            expect(files.map((f: { filename: string }) => f.filename)).toEqual([
                'zz/own.ts',
            ]);
        });

        it('keeps only removed files outside the PR, not the other files of a merge', async () => {
            const { service } = makeService([gone, file('merged/a.ts')]);

            const files = await read(service, true);

            expect(files.map((f: { filename: string }) => f.filename)).toEqual([
                'src/new-in-pr.ts',
            ]);
        });
    });
});
