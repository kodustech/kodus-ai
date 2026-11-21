const repoGetPullRequestFiles = jest.fn();
const repoDownloadPullDiffOrPatch = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoGetPullRequestFiles: (...args: unknown[]) =>
        repoGetPullRequestFiles(...args),
    repoDownloadPullDiffOrPatch: (...args: unknown[]) =>
        repoDownloadPullDiffOrPatch(...args),
}));

import { ForgejoService } from './forgejo.service';

/**
 * The Forgejo client answers an HTTP error instead of throwing it. A 429 on
 * the file listing or the diff must reach the job as a rate limit (so it
 * retries), not as a PR with fewer files or no patches.
 */
describe('ForgejoService.getFilesByPullRequestId under a rate limit', () => {
    // What the client hands back for an HTTP error: the axios error itself
    const httpError = (status: number) =>
        Object.assign(new Error(`Request failed with status code ${status}`), {
            response: { status },
            error: {},
        });
    // What the client hands back when the connection drops: the axios error
    // itself, with no response and `error: {}` (its client catches it).
    const connectionDropped = (code: string, message: string) =>
        Object.assign(new Error(message), {
            code,
            error: {},
            config: { headers: { Authorization: 'token secret-token' } },
        });
    const DIFF = [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '',
    ].join('\n');

    const makeService = () => {
        const service = Object.create(
            ForgejoService.prototype,
        ) as ForgejoService;
        const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
        Object.defineProperty(service, 'logger', { value: logger });
        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue({ host: 'https://git.test' });
        jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as never);
        return { service, logger };
    };
    const list = (service: ForgejoService) =>
        service.getFilesByPullRequestId({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { name: 'acme/widget' },
            prNumber: 7,
        });

    beforeEach(() => {
        repoGetPullRequestFiles.mockReset();
        repoDownloadPullDiffOrPatch.mockReset();
        repoGetPullRequestFiles.mockResolvedValue({
            data: [{ filename: 'src/a.ts', status: 'modified' }],
        });
        repoDownloadPullDiffOrPatch.mockResolvedValue({ data: DIFF });
    });

    it('lists files with their patches', async () => {
        const { service } = makeService();

        const files = await list(service);

        expect(files?.map((f) => [f.filename, f.patch])).toEqual([
            ['src/a.ts', expect.stringContaining('@@ -1 +1 @@')],
        ]);
    });

    it('keys a patch by its full path, even one holding " b/"', async () => {
        repoGetPullRequestFiles.mockResolvedValue({
            data: [{ filename: 'docs/a b/f.md', status: 'modified' }],
        });
        repoDownloadPullDiffOrPatch.mockResolvedValue({
            data: [
                'diff --git a/docs/a b/f.md b/docs/a b/f.md',
                '--- a/docs/a b/f.md',
                '+++ b/docs/a b/f.md',
                '@@ -1 +1 @@',
                '-x',
                '+y',
                '',
            ].join('\n'),
        });
        const { service } = makeService();

        const files = await list(service);

        expect(files?.[0]?.patch).toBe('@@ -1 +1 @@\n-x\n+y');
    });

    it('lets a 429 on a file listing page through', async () => {
        repoGetPullRequestFiles.mockResolvedValue(httpError(429));
        const { service } = makeService();

        await expect(list(service)).rejects.toMatchObject({
            response: { status: 429 },
        });
    });

    it('lets a 429 on the diff through, answered or thrown', async () => {
        const { service } = makeService();

        repoDownloadPullDiffOrPatch.mockResolvedValue(httpError(429));
        await expect(list(service)).rejects.toMatchObject({
            response: { status: 429 },
        });

        repoDownloadPullDiffOrPatch.mockRejectedValue(httpError(429));
        await expect(list(service)).rejects.toMatchObject({
            response: { status: 429 },
        });
    });

    it('lets a transport failure on the diff through instead of empty patches', async () => {
        repoDownloadPullDiffOrPatch.mockRejectedValue(
            new TypeError('fetch failed'),
        );
        const { service } = makeService();

        await expect(list(service)).rejects.toThrow('fetch failed');
    });

    it('still lists the files without patches when the diff fails otherwise', async () => {
        repoDownloadPullDiffOrPatch.mockRejectedValue(
            new Error('unexpected payload'),
        );
        const { service, logger } = makeService();

        const files = await list(service);

        expect(files?.map((f) => [f.filename, f.patch])).toEqual([
            ['src/a.ts', ''],
        ]);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: {
                    organizationId: 'org-1',
                    teamId: 't',
                    repository: 'acme/widget',
                    prNumber: 7,
                },
            }),
        );
    });

    it('lets a server error on a later file page through instead of a partial listing', async () => {
        repoGetPullRequestFiles
            .mockResolvedValueOnce({
                data: Array.from({ length: 50 }, (_, i) => ({
                    filename: `src/f${i}.ts`,
                    status: 'modified',
                })),
            })
            .mockResolvedValueOnce(httpError(502));
        const { service } = makeService();

        await expect(list(service)).rejects.toMatchObject({ status: 502 });
    });

    it('lets a server error on the diff through instead of empty patches', async () => {
        repoDownloadPullDiffOrPatch.mockResolvedValue(httpError(503));
        const { service } = makeService();

        await expect(list(service)).rejects.toMatchObject({ status: 503 });
    });

    it('warns and lists without patches when the diff answers another error', async () => {
        repoDownloadPullDiffOrPatch.mockResolvedValue(httpError(404));
        const { service, logger } = makeService();

        const files = await list(service);

        expect(files?.map((f) => [f.filename, f.patch])).toEqual([
            ['src/a.ts', ''],
        ]);
        expect(logger.warn).toHaveBeenCalled();
    });

    it('lets a transport failure on the listing through', async () => {
        repoGetPullRequestFiles.mockRejectedValue(new Error('socket hang up'));
        const { service } = makeService();

        await expect(list(service)).rejects.toThrow('socket hang up');
    });

    it.each([
        ['ECONNRESET', 'read ECONNRESET'],
        ['ERR_NETWORK', 'Network Error'],
        ['ECONNRESET', 'socket hang up'],
    ])(
        'lets a connection the client answered as dropped (%s) through on the listing, not as no files',
        async (code, message) => {
            repoGetPullRequestFiles.mockResolvedValue(
                connectionDropped(code, message),
            );
            const { service } = makeService();

            await expect(list(service)).rejects.toMatchObject({
                code,
                message,
            });
        },
    );

    it('lets a connection the client answered as dropped through on the diff, not as empty patches', async () => {
        repoDownloadPullDiffOrPatch.mockResolvedValue(
            connectionDropped('ECONNRESET', 'read ECONNRESET'),
        );
        const { service } = makeService();

        await expect(list(service)).rejects.toMatchObject({
            code: 'ECONNRESET',
        });
    });

    it('never carries the request config, which holds the token, in what it throws', async () => {
        repoGetPullRequestFiles.mockResolvedValue(
            connectionDropped('ECONNRESET', 'read ECONNRESET'),
        );
        const { service } = makeService();

        const thrown = await list(service).catch((error) => error);

        // It did throw: a resolved listing would pass the checks below.
        expect(thrown).toMatchObject({ code: 'ECONNRESET' });
        expect(thrown).not.toHaveProperty('config');
        // message and stack are not enumerable, so JSON.stringify misses them.
        for (const channel of [
            thrown.message,
            thrown.stack ?? '',
            JSON.stringify(thrown),
        ]) {
            expect(channel).not.toContain('secret-token');
        }
    });

    it('answers null when the listing fails for another reason', async () => {
        repoGetPullRequestFiles.mockRejectedValue(
            new Error('unexpected payload'),
        );
        const { service, logger } = makeService();

        await expect(list(service)).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ organizationId: 'org-1' }),
            }),
        );
    });
});
