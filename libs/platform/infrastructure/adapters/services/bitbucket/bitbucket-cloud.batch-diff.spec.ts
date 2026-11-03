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
            // The incremental read pages the diffstat itself (readAllPages);
            // answer it with the same list the test set for the full one
            getDiffStat: jest.fn(async () => ({
                data: { values: await (service as any).getPaginatedResults() },
            })),
        },
        hasNextPage: () => false,
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
        // Contents are read later per kept file, never here
        expect(read).not.toHaveBeenCalled();
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
        expect(read).not.toHaveBeenCalled();
    });

    it('reads a missing file on its own when the whole diff has a section it could not key', async () => {
        const onlyA = wholeDiff.split(/(?=^diff --git a\/src\/b)/m)[0];
        const bSection = wholeDiff
            .split(/(?=^diff --git )/m)
            .find((section) => section.includes('b/src/b.ts'));
        const getDiff = jest.fn((args: { path?: string }) =>
            Promise.resolve({
                data: args.path
                    ? bSection
                    : `${onlyA}diff --git unparseable-header\n`,
            }),
        );
        const { service } = makeService(getDiff as any);

        const files = await service.getChangedFilesSinceLastCommit({
            organizationAndTeamData: org as any,
            repository: { id: 'repo-1', name: 'web' },
            prNumber: 7,
            lastCommit: { sha: 'last' },
        });

        expect(getDiff).toHaveBeenCalledTimes(2);
        expect(getDiff.mock.calls[1][0].path).toBe('src/b.ts');
        expect(files?.map((f) => [f.filename, f.patch])).toEqual([
            ['src/a.ts', '@@ -1 +1 @@\n-old a\n+new a'],
            ['src/b.ts', '@@ -0,0 +1 @@\n+new b'],
        ]);
    });
});

describe('BitbucketCloudService.getChangedFilesSinceLastCommit — deletions and failed reads', () => {
    const since = (service: BitbucketCloudService) =>
        service.getChangedFilesSinceLastCommit({
            organizationAndTeamData: org as any,
            repository: { id: 'repo-1', name: 'web' },
            prNumber: 7,
            lastCommit: { sha: 'last' },
        });

    it('does not read unchanged files one by one when the diff holds a deletion', async () => {
        const withDeletion = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-old a',
            '+new a',
            'diff --git a/src/gone.ts b/src/gone.ts',
            'deleted file mode 100644',
            '--- a/src/gone.ts',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-bye',
            '',
        ].join('\n');
        const getDiff = jest.fn().mockResolvedValue({ data: withDeletion });
        const { service } = makeService(getDiff);
        jest.spyOn(service as any, 'getPaginatedResults').mockResolvedValue([
            ...diffstat,
            { status: 'removed', old: { path: 'src/gone.ts' } },
        ]);

        const files = await since(service);

        // src/b.ts did not change since the last commit: no per-file read
        expect(getDiff).toHaveBeenCalledTimes(1);
        expect(files?.map((f) => f.filename)).toEqual(['src/a.ts']);
    });

    it('keeps a file whose diff could not be read instead of dropping it as unchanged', async () => {
        const getDiff = jest.fn((args: { path?: string }) =>
            args.path === 'src/b.ts'
                ? Promise.reject(new Error('502 Bad Gateway'))
                : Promise.resolve({
                      data: `${wholeDiff.split(/(?=^diff --git a\/src\/b)/m)[0]}diff --git unparseable-header\n`,
                  }),
        );
        const { service } = makeService(getDiff as any);

        const files = await since(service);

        expect(files?.map((f) => [f.filename, f.patch])).toEqual([
            ['src/a.ts', '@@ -1 +1 @@\n-old a\n+new a'],
            ['src/b.ts', null],
        ]);
    });
});

describe('BitbucketCloudService — whole-diff fallbacks and their logs', () => {
    const since = (service: BitbucketCloudService) =>
        service.getChangedFilesSinceLastCommit({
            organizationAndTeamData: org as any,
            repository: { id: 'repo-1', name: 'web' },
            prNumber: 7,
            lastCommit: { sha: 'last' },
        });
    const sectionFor = (path: string) =>
        wholeDiff
            .split(/(?=^diff --git )/m)
            .find((section) => section.includes(`b/${path}`))!;
    const rateLimited = () =>
        Object.assign(new Error('Too Many Requests'), {
            name: 'HTTPError',
            status: 429,
        });
    const logger = (service: BitbucketCloudService) =>
        (service as any).logger as { warn: jest.Mock };

    it('reads a file the whole PR diff left out on its own, with the PR spec', async () => {
        const getDiff = jest.fn((args: { path?: string }) =>
            Promise.resolve({
                data: args.path
                    ? sectionFor(args.path)
                    : sectionFor('src/a.ts'),
            }),
        );
        const { service } = makeService(getDiff as any);

        const files = await getFiles(service);

        expect(getDiff).toHaveBeenCalledTimes(2);
        expect(getDiff.mock.calls[1][0]).toEqual({
            repo_slug: '{repo-1}',
            workspace: '{ws-1}',
            spec: 'head..base',
            path: 'src/b.ts',
        });
        expect(files?.map((f) => f.patch)).toEqual([
            '@@ -1 +1 @@\n-old a\n+new a',
            '@@ -0,0 +1 @@\n+new b',
        ]);
        // Every section was keyed: filling a gap is not worth a warning
        expect(logger(service).warn).not.toHaveBeenCalled();
    });

    it('keys a removed file by its old path in the full listing', async () => {
        const removed = [
            'diff --git a/src/gone.ts b/src/gone.ts',
            'deleted file mode 100644',
            '--- a/src/gone.ts',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-bye',
            '',
        ].join('\n');
        const getDiff = jest.fn().mockResolvedValue({ data: removed });
        const { service } = makeService(getDiff);
        jest.spyOn(service as any, 'getPaginatedResults').mockResolvedValue([
            {
                status: 'removed',
                old: { path: 'src/gone.ts' },
                lines_added: 0,
                lines_removed: 1,
            },
        ]);

        const files = await getFiles(service);

        expect(getDiff).toHaveBeenCalledTimes(1);
        expect(files?.map((f) => f.patch)).toEqual(['@@ -1 +0,0 @@\n-bye']);
    });

    it('keeps what follows the 4 header lines of a per-file diff it cannot split', async () => {
        const getDiff = jest.fn((args: { path?: string }) =>
            args.path
                ? Promise.resolve({
                      data: [
                          'Index: src/b.ts',
                          '===================================================================',
                          '--- src/b.ts',
                          '+++ src/b.ts',
                          '@@ -1 +1 @@',
                          '-old b',
                          '+new b',
                      ].join('\n'),
                  })
                : Promise.reject(new Error('diff too large')),
        );
        const { service } = makeService(getDiff as any);

        const files = await getFiles(service);

        expect(files?.find((f) => f.filename === 'src/b.ts')?.patch).toBe(
            '@@ -1 +1 @@\n-old b\n+new b',
        );
    });

    it('logs the failed whole diff with the organization and falls back', async () => {
        const getDiff = jest.fn((args: { path?: string }) =>
            args.path
                ? Promise.resolve({ data: sectionFor(args.path) })
                : Promise.reject(new Error('diff too large')),
        );
        const { service } = makeService(getDiff as any);

        await getFiles(service);

        expect(logger(service).warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message:
                    'Whole-PR diff failed for spec head..base; falling back to per-file diffs',
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    prNumber: 7,
                    repoId: 'repo-1',
                    files: 2,
                }),
            }),
        );
        // A failed read is not a parse mismatch: one warning, not two
        expect(logger(service).warn).toHaveBeenCalledTimes(1);
    });

    it('lets a 429 on a per-file read through', async () => {
        const getDiff = jest.fn((args: { path?: string }) =>
            args.path
                ? Promise.reject(rateLimited())
                : Promise.reject(new Error('diff too large')),
        );
        const { service } = makeService(getDiff as any);

        await expect(getFiles(service)).rejects.toMatchObject({ status: 429 });
    });

    it('answers null, not a throw, when listing fails for another reason', async () => {
        const { service } = makeService(jest.fn());
        jest.spyOn(service as any, 'getPaginatedResults').mockRejectedValue(
            new Error('500 from Bitbucket'),
        );

        await expect(getFiles(service)).resolves.toBeNull();
    });

    it('incremental: reads files one by one when the whole diff fails', async () => {
        const getDiff = jest.fn((args: { path?: string }) =>
            args.path
                ? Promise.resolve({ data: sectionFor(args.path) })
                : Promise.reject(new Error('diff too large')),
        );
        const { service } = makeService(getDiff as any);

        const files = await since(service);

        // The whole-spec read was tried first, then each file on its own
        expect(getDiff).toHaveBeenCalledTimes(3);
        expect(getDiff.mock.calls[0][0]).toEqual({
            repo_slug: '{repo-1}',
            workspace: '{ws-1}',
            spec: 'head..last',
        });

        expect(files?.map((f) => f.filename)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('incremental: a diff keying a file the listing lacks is read again per file, and warned with the organization', async () => {
        // Every section keyed, but one names a file the listing lacks
        const extra =
            sectionFor('src/a.ts') +
            [
                'diff --git a/src/elsewhere.ts b/src/elsewhere.ts',
                '--- a/src/elsewhere.ts',
                '+++ b/src/elsewhere.ts',
                '@@ -1 +1 @@',
                '-x',
                '+y',
                '',
            ].join('\n');
        const getDiff = jest.fn((args: { path?: string }) =>
            Promise.resolve({
                data: args.path ? sectionFor(args.path) : extra,
            }),
        );
        const { service } = makeService(getDiff as any);

        const files = await since(service);

        expect(getDiff.mock.calls.map(([a]) => a.path)).toEqual([
            undefined,
            'src/b.ts',
        ]);
        expect(files?.map((f) => f.filename)).toEqual(['src/a.ts', 'src/b.ts']);
        expect(logger(service).warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message:
                    'Whole-PR diff for spec head..last did not key every file; reading 1 missing file(s) one by one',
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    missing: 1,
                }),
            }),
        );
    });

    it('incremental: drops a file whose diff since the last commit has no hunks', async () => {
        const modeOnly =
            sectionFor('src/a.ts') +
            [
                'diff --git a/src/b.ts b/src/b.ts',
                'old mode 100644',
                'new mode 100755',
                '',
            ].join('\n');
        const getDiff = jest.fn().mockResolvedValue({ data: modeOnly });
        const { service } = makeService(getDiff);

        const files = await since(service);

        expect(files?.map((f) => f.filename)).toEqual(['src/a.ts']);
        expect(files?.[0]).toMatchObject({
            sha: 'head',
            additions: 1,
            deletions: 1,
            changes: 2,
        });
    });

    it('incremental: logs a failed per-file read with the path and organization', async () => {
        const getDiff = jest.fn((args: { path?: string }) =>
            args.path
                ? Promise.reject(new Error('502 Bad Gateway'))
                : Promise.reject(new Error('diff too large')),
        );
        const { service } = makeService(getDiff as any);

        await since(service);

        expect(logger(service).warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message:
                    'Could not read the diff of src/b.ts for spec head..last',
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    path: 'src/b.ts',
                }),
            }),
        );
    });

    it('incremental: answers null, not a throw, when listing fails for another reason', async () => {
        const { service } = makeService(jest.fn());
        jest.spyOn(service as any, 'getPaginatedResults').mockRejectedValue(
            new Error('500 from Bitbucket'),
        );

        await expect(since(service)).resolves.toBeNull();
    });

    it('incremental: lets a 429 through instead of answering null', async () => {
        const getDiff = jest.fn().mockRejectedValue(rateLimited());
        const { service } = makeService(getDiff);

        await expect(since(service)).rejects.toMatchObject({ status: 429 });
    });
});
