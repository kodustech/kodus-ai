jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { BitbucketCloudService } from './bitbucket-cloud.service';

/**
 * Reading a PR's files must not cost one diff request per file.
 *
 * `getFilesByPullRequestId` and `getChangedFilesSinceLastCommit` asked
 * `commits.getDiff` once per changed file, all in parallel, and swallowed
 * every failure into a null patch. On large PRs Bitbucket answered 429 and
 * the review silently lost the diffs. They now read one diff for the whole
 * spec and split it per file.
 */

const org = { organizationId: 'org-1', teamId: 'team-1' };

const wholeDiff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old a',
    '+new a',
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    'index 000..333',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1 @@',
    '+new b',
    '',
].join('\n');

const diffstat = [
    {
        status: 'modified',
        new: { path: 'src/a.ts' },
        old: { path: 'src/a.ts' },
        lines_added: 1,
        lines_removed: 1,
    },
    {
        status: 'added',
        new: { path: 'src/b.ts' },
        lines_added: 1,
        lines_removed: 0,
    },
];

const rateLimited = () =>
    Object.assign(new Error('Too Many Requests'), {
        name: 'HTTPError',
        status: 429,
    });

function makeService(getDiff: jest.Mock) {
    const service = new BitbucketCloudService(
        { findOne: jest.fn() } as any,
        { createOrUpdateConfig: jest.fn() } as any,
        { findOne: jest.fn() } as any,
        { get: jest.fn() } as any,
    );
    const read = jest.fn().mockResolvedValue({ data: 'contents' });

    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
        token: 't',
    });
    jest.spyOn(service as any, 'getRepoById').mockResolvedValue({
        id: 'repo-1',
        workspaceId: 'ws-1',
    });
    jest.spyOn(service as any, 'getPaginatedResults').mockResolvedValue(
        diffstat,
    );
    jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
        pullrequests: {
            get: jest.fn().mockResolvedValue({
                data: {
                    source: { commit: { hash: 'head' } },
                    destination: { commit: { hash: 'base' } },
                },
            }),
            getDiffStat: jest.fn().mockResolvedValue({ data: {} }),
        },
        commits: { getDiff },
        source: { read },
    });
    (service as any).logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };

    return { service, read };
}

const getFiles = (service: BitbucketCloudService) =>
    service.getFilesByPullRequestId({
        organizationAndTeamData: org as any,
        repository: { id: 'repo-1', name: 'web' },
        prNumber: 7,
    });

describe('BitbucketCloudService.getFilesByPullRequestId — batch diff', () => {
    it('reads one diff for the whole PR and splits it per file', async () => {
        const getDiff = jest.fn().mockResolvedValue({ data: wholeDiff });
        const { service, read } = makeService(getDiff);

        const files = await getFiles(service);

        expect(getDiff).toHaveBeenCalledTimes(1);
        expect(getDiff.mock.calls[0][0]).toEqual({
            repo_slug: '{repo-1}',
            workspace: '{ws-1}',
            spec: 'head..base',
        });
        expect(read).toHaveBeenCalledTimes(2);
        expect(files?.map((f) => [f.filename, f.patch])).toEqual([
            ['src/a.ts', '@@ -1 +1 @@\n-old a\n+new a'],
            ['src/b.ts', '@@ -0,0 +1 @@\n+new b'],
        ]);
    });

    it('falls back to per-file diffs when the whole diff fails', async () => {
        const getDiff = jest.fn((args: { path?: string }) =>
            args.path
                ? Promise.resolve({
                      data: wholeDiff
                          .split(/(?=^diff --git )/m)
                          .find((s) => s.includes(`b/${args.path}`)),
                  })
                : Promise.reject(new Error('diff too large')),
        );
        const { service } = makeService(getDiff as any);

        const files = await getFiles(service);

        expect(getDiff).toHaveBeenCalledTimes(3);
        expect(files?.map((f) => f.patch)).toEqual([
            '@@ -1 +1 @@\n-old a\n+new a',
            '@@ -0,0 +1 @@\n+new b',
        ]);
    });

    it('rethrows a rate limit instead of returning files without patches', async () => {
        const getDiff = jest.fn().mockRejectedValue(rateLimited());
        const { service } = makeService(getDiff);

        await expect(getFiles(service)).rejects.toMatchObject({ status: 429 });
        expect(getDiff).toHaveBeenCalledTimes(1);
    });
});

describe('BitbucketCloudService.getChangedFilesSinceLastCommit — batch diff', () => {
    it('reads one diff since the last commit and skips files absent from it', async () => {
        const onlyA = wholeDiff.split(/(?=^diff --git a\/src\/b)/m)[0];
        const getDiff = jest.fn().mockResolvedValue({ data: onlyA });
        const { service, read } = makeService(getDiff);

        const files = await service.getChangedFilesSinceLastCommit({
            organizationAndTeamData: org as any,
            repository: { id: 'repo-1', name: 'web' },
            prNumber: 7,
            lastCommit: { sha: 'last' },
        });

        expect(getDiff).toHaveBeenCalledTimes(1);
        expect(getDiff.mock.calls[0][0].spec).toBe('head..last');
        expect(files?.map((f) => f.filename)).toEqual(['src/a.ts']);
        // Content only for the file that changed
        expect(read).toHaveBeenCalledTimes(1);
    });
});
