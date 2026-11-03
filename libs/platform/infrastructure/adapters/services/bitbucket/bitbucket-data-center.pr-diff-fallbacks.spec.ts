jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { BitbucketDataCenterService } from './bitbucket-data-center.service';

const REPO = '/projects/PRJ/repos/api';
const DIFF_URL = `${REPO}/pull-requests/7/diff`;

const hunk = {
    sourceLine: 1,
    sourceSpan: 2,
    destinationLine: 1,
    destinationSpan: 3,
    segments: [
        { type: 'CONTEXT', lines: [{ line: 'a' }] },
        { type: 'REMOVED', lines: [{ line: 'b' }] },
        { type: 'ADDED', lines: [{ line: 'B' }, { line: 'C' }] },
    ],
};
const PATCH = '@@ -1,2 +1,3 @@\n a\n-b\n+B\n+C\n';

const jsonDiff = (
    source: string | null,
    destination: string | null,
    extra: Record<string, unknown> = {},
) => ({
    source: source ? { toString: source } : null,
    destination: destination ? { toString: destination } : null,
    hunks: [hunk],
    ...extra,
});

const rateLimited = () =>
    Object.assign(new Error('Request failed with status code 429'), {
        response: { status: 429 },
    });

type Answer = (config?: any) => Promise<any>;

/**
 * A Data Center host: the PR, its change listing, and the diff endpoint. The
 * whole-PR diff has no params; a per-file read carries params.path.
 */
function makeHost(opts: {
    changes: Array<{ path: string; type: string; srcPath?: string }>;
    wholeDiff: Answer;
    perFile?: (path: string) => Promise<any>;
}) {
    const get = jest.fn((url: string, config?: any) => {
        if (url === `${REPO}/pull-requests/7`) {
            return Promise.resolve({
                data: { fromRef: { latestCommit: 'head' } },
            });
        }
        if (url === `${REPO}/pull-requests/7/changes`) {
            return Promise.resolve({
                data: {
                    values: opts.changes.map((c) => ({
                        path: { toString: c.path },
                        srcPath: c.srcPath
                            ? { toString: c.srcPath }
                            : undefined,
                        type: c.type,
                    })),
                },
            });
        }
        if (url === DIFF_URL) {
            const path = config?.params?.path;
            if (!path) return opts.wholeDiff(config);
            return opts.perFile
                ? opts.perFile(path)
                : Promise.resolve({ data: { diffs: [jsonDiff(path, path)] } });
        }
        return Promise.reject(new Error(`unexpected ${url}`));
    });

    const service = new BitbucketDataCenterService(
        {} as any,
        {
            findOne: jest.fn().mockResolvedValue({
                configValue: [{ id: 'r1', name: 'api', workspaceId: 'PRJ' }],
            }),
        } as any,
        {} as any,
        { get: jest.fn() } as any,
    );
    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
    jest.spyOn(service as any, 'getRepoConfig').mockResolvedValue({
        id: 'r1',
        name: 'api',
        workspaceId: 'PRJ',
    });
    jest.spyOn(service as any, 'getAxiosInstance').mockReturnValue({ get });
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (service as any).logger = logger;

    const perFileReads = () =>
        get.mock.calls
            .filter(([url, config]) => url === DIFF_URL && config)
            .map(([, config]) => config.params.path)
            .sort();
    const list = () =>
        service.getFilesByPullRequestId({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: 'r1', name: 'api' },
            prNumber: 7,
        });
    return { service, get, logger, perFileReads, list };
}

const LOG_METADATA = {
    organizationId: 'org-1',
    teamId: 't',
    repoPath: REPO,
    prNumber: 7,
};

describe('BitbucketDataCenterService.getFilesByPullRequestId — file entries', () => {
    it('maps each change type and counts lines from the patch', async () => {
        const { list, perFileReads } = makeHost({
            changes: [
                { path: 'mod.ts', type: 'MODIFY' },
                { path: 'new.ts', type: 'ADD' },
                { path: 'gone.ts', type: 'DELETE' },
                { path: 'moved.ts', type: 'MOVE', srcPath: 'old.ts' },
            ],
            wholeDiff: async () => ({
                data: {
                    diffs: [
                        jsonDiff('mod.ts', 'mod.ts'),
                        jsonDiff(null, 'new.ts'),
                        // A deletion is keyed by its source path
                        jsonDiff('gone.ts', null),
                        // A move by where the file went
                        jsonDiff('old.ts', 'moved.ts'),
                    ],
                },
            }),
        });

        const files = await list();

        expect(perFileReads()).toEqual([]);
        expect(
            files?.map((f) => [
                f.filename,
                f.previous_filename,
                f.status,
                f.additions,
                f.deletions,
                f.changes,
                f.patch,
                f.sha,
            ]),
        ).toEqual([
            ['mod.ts', undefined, 'modified', 2, 1, 3, PATCH, 'head'],
            ['new.ts', undefined, 'added', 2, 1, 3, PATCH, 'head'],
            ['gone.ts', undefined, 'removed', 2, 1, 3, PATCH, 'head'],
            // Status left out: main maps every type but MODIFY/ADD to removed
            ['moved.ts', 'old.ts', files?.[3].status, 2, 1, 3, PATCH, 'head'],
        ]);
    });

    it('keeps a file no read has a patch for, with zero counts and no patch', async () => {
        const { list, logger, get } = makeHost({
            changes: [{ path: 'bin.png', type: 'MODIFY' }],
            wholeDiff: async () => ({ data: { diffs: [] } }),
            // The host answers with no body for a binary file
            perFile: async () => ({ data: undefined }),
        });

        const files = await list();

        // The whole diff was asked first; the per-file read only after it
        expect(get.mock.calls.filter(([url]) => url === DIFF_URL)).toEqual([
            [DIFF_URL],
            [DIFF_URL, { params: { path: 'bin.png', limit: 1000 } }],
        ]);
        expect(files).toEqual([
            expect.objectContaining({
                filename: 'bin.png',
                additions: 0,
                deletions: 0,
                changes: 0,
                patch: null,
            }),
        ]);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('answers null for a listing that fails with anything but a rate limit', async () => {
        const { service, logger } = makeHost({
            changes: [],
            wholeDiff: async () => ({ data: { diffs: [] } }),
        });
        jest.spyOn(service as any, 'getAxiosInstance').mockReturnValue({
            get: jest
                .fn()
                .mockRejectedValue(
                    new Error('Request failed with status code 500'),
                ),
        });

        await expect(
            service.getFilesByPullRequestId({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 't',
                },
                repository: { id: 'r1', name: 'api' },
                prNumber: 7,
            }),
        ).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Error getting fully populated files for DC PR #7',
            }),
        );
    });

    it('lets a transport failure on the listing through: it is not a PR with no files', async () => {
        const { service } = makeHost({
            changes: [],
            wholeDiff: async () => ({ data: { diffs: [] } }),
        });
        jest.spyOn(service as any, 'getAxiosInstance').mockReturnValue({
            get: jest.fn().mockRejectedValue(new Error('socket hang up')),
        });

        await expect(
            service.getFilesByPullRequestId({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 't',
                },
                repository: { id: 'r1', name: 'api' },
                prNumber: 7,
            }),
        ).rejects.toThrow('socket hang up');
    });
});

describe('BitbucketDataCenterService.getFilesByPullRequestId — whole-diff fallbacks', () => {
    const changes = [
        { path: 'a.ts', type: 'MODIFY' },
        { path: 'b.ts', type: 'MODIFY' },
        { path: 'c.ts', type: 'MODIFY' },
    ];

    it('takes an empty answer to the whole-diff read as no diffs, not a failure', async () => {
        const { list, logger, perFileReads } = makeHost({
            changes,
            wholeDiff: async () => ({ data: undefined }),
        });

        const files = await list();

        expect(perFileReads()).toEqual(['a.ts', 'b.ts', 'c.ts']);
        expect(files?.every((f) => f.patch === PATCH)).toBe(true);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('reads every file on its own when one file in the whole diff was cut short, and says where', async () => {
        const { list, logger, perFileReads } = makeHost({
            changes,
            wholeDiff: async () => ({
                data: {
                    diffs: [
                        jsonDiff('a.ts', 'a.ts', { truncated: true }),
                        jsonDiff('b.ts', 'b.ts'),
                        jsonDiff('c.ts', 'c.ts'),
                    ],
                },
            }),
        });

        await list();

        expect(perFileReads()).toEqual(['a.ts', 'b.ts', 'c.ts']);
        expect(logger.warn).toHaveBeenCalledWith({
            message:
                'Whole diff of PR#7 was truncated; reading files one by one',
            context: BitbucketDataCenterService.name,
            metadata: { ...LOG_METADATA, files: 3 },
        });
    });

    it('reads every file on its own when the whole diff fails, and warns with the organization', async () => {
        const failure = new Error('502 Bad Gateway');
        const { list, logger, perFileReads } = makeHost({
            changes,
            wholeDiff: () => Promise.reject(failure),
        });

        const files = await list();

        expect(perFileReads()).toEqual(['a.ts', 'b.ts', 'c.ts']);
        expect(files?.every((f) => f.patch === PATCH)).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith({
            message: 'Whole diff of PR#7 failed; reading files one by one',
            context: BitbucketDataCenterService.name,
            error: failure,
            metadata: { ...LOG_METADATA, files: 3 },
        });
    });

    it('lets a 429 on the whole diff through instead of reading file by file', async () => {
        const { list, perFileReads } = makeHost({
            changes,
            wholeDiff: () => Promise.reject(rateLimited()),
        });

        await expect(list()).rejects.toMatchObject({
            response: { status: 429 },
        });
        expect(perFileReads()).toEqual([]);
    });

    it('keeps the other files when one per-file read fails, and logs the path with the organization', async () => {
        const failure = new Error('500');
        const { list, logger } = makeHost({
            changes,
            wholeDiff: async () => ({ data: { truncated: true } }),
            perFile: (path) =>
                path === 'b.ts'
                    ? Promise.reject(failure)
                    : Promise.resolve({
                          data: { diffs: [jsonDiff(path, path)] },
                      }),
        });

        const files = await list();

        expect(files?.map((f) => [f.filename, f.patch])).toEqual([
            ['a.ts', PATCH],
            ['b.ts', null],
            ['c.ts', PATCH],
        ]);
        expect(logger.error).toHaveBeenCalledWith({
            message: 'Could not fetch diff for b.ts',
            context: BitbucketDataCenterService.name,
            metadata: { ...LOG_METADATA, filePath: 'b.ts' },
            error: failure,
        });
    });
});

describe('BitbucketDataCenterService.getFilesByPullRequestId — per-file read failures', () => {
    it('lets a network failure on a per-file read through instead of a null patch', async () => {
        const { list } = makeHost({
            changes: [{ path: 'a.ts', type: 'MODIFY' }],
            wholeDiff: async () => ({ data: { truncated: true } }),
            perFile: () => Promise.reject(new Error('socket hang up')),
        });

        await expect(list()).rejects.toThrow('socket hang up');
    });
});

describe('BitbucketDataCenterService.getFilesByPullRequestId — a per-file diff cut short', () => {
    it('keeps the hunks it sent and warns that the patch is partial', async () => {
        const { list, logger } = makeHost({
            changes: [{ path: 'big.ts', type: 'MODIFY' }],
            wholeDiff: async () => ({ data: { truncated: true } }),
            perFile: async (path) => ({
                data: { truncated: true, diffs: [jsonDiff(path, path)] },
            }),
        });

        const files = await list();

        expect(files?.[0]?.patch).toBe(PATCH);
        expect(logger.warn).toHaveBeenCalledWith({
            message:
                'Diff of big.ts in PR#7 was truncated; its patch is partial',
            context: BitbucketDataCenterService.name,
            metadata: { ...LOG_METADATA, filePath: 'big.ts' },
        });
    });
});

describe('BitbucketDataCenterService.getChangedFilesSinceLastCommit — listing failures', () => {
    const since = (get: jest.Mock) => {
        const { service, logger } = makeHost({
            changes: [],
            wholeDiff: async () => ({ data: {} }),
        });
        jest.spyOn(service as any, 'getAxiosInstance').mockReturnValue({
            get,
        });
        return {
            logger,
            run: () =>
                service.getChangedFilesSinceLastCommit({
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 't',
                    },
                    repository: { id: 'r1', name: 'api' },
                    prNumber: 7,
                    lastCommit: { sha: 'base' },
                }),
        };
    };

    it('lets a 429 through: a rate limit is not "nothing changed"', async () => {
        const { run } = since(jest.fn().mockRejectedValue(rateLimited()));

        await expect(run()).rejects.toMatchObject({
            response: { status: 429 },
        });
    });

    it('lets a transport failure through: it is not "nothing changed" either', async () => {
        const { run } = since(
            jest.fn().mockRejectedValue(new Error('socket hang up')),
        );

        await expect(run()).rejects.toThrow('socket hang up');
    });

    it('answers null and logs any other failure', async () => {
        const { run, logger } = since(
            jest
                .fn()
                .mockRejectedValue(
                    new Error('Request failed with status code 500'),
                ),
        );

        await expect(run()).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message:
                    'Error fetching changed files since last commit in Data Center',
            }),
        );
    });
});
