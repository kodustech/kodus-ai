import { PullRequestHandlerService } from './pullRequestManager.service';

/**
 * #2268: an incremental read the provider could not complete (`null`) is not
 * a PR with nothing new. What is new is read from the PR diff at the last
 * reviewed commit, as after a rebase; failing that, the whole PR is read.
 */
describe('PullRequestHandlerService — unreadable incremental diff', () => {
    const orgData: any = { organizationId: 'org-1', teamId: 'team-1' };
    const repository = { name: 'repo', id: 'repo-id' };
    const pullRequest = {
        number: 42,
        head: { sha: 'new-head' },
        base: { ref: 'main' },
    };
    const lastCommit: any = { sha: 'reviewed-sha' };

    const own = { filename: 'src/own.ts', patch: '@@ -1 +1 @@\n-a\n+b' };
    const ownNow = {
        filename: 'src/own.ts',
        patch: '@@ -1 +1,2 @@\n-a\n+b\n+c',
    };

    const makeService = (overrides: {
        sinceLastCommit: unknown;
        atCommit?: unknown;
        prFiles?: unknown[];
    }) => {
        const codeManagementService = {
            getChangedFilesSinceLastCommit: jest
                .fn()
                .mockResolvedValue(overrides.sinceLastCommit),
            getPullRequestFilesAtCommit: jest
                .fn()
                .mockResolvedValue(overrides.atCommit ?? null),
            getFilesByPullRequestId: jest
                .fn()
                .mockResolvedValue(
                    'prFiles' in overrides ? overrides.prFiles : [],
                ),
            getRepositoryContentFile: jest
                .fn()
                .mockResolvedValue({ data: { content: 'x' } }),
        };
        const service = new PullRequestHandlerService(
            codeManagementService as any,
            {} as any,
        );
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (service as any).logger = logger;
        return { service, codeManagementService, logger };
    };

    const metadata = (service: PullRequestHandlerService, base: any) =>
        service.getChangedFilesMetadata(orgData, repository, pullRequest, base);

    it('passes a readable incremental diff through', async () => {
        const { service, codeManagementService } = makeService({
            sinceLastCommit: [own],
        });

        await expect(metadata(service, lastCommit)).resolves.toEqual([own]);
        expect(
            codeManagementService.getChangedFilesSinceLastCommit,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: orgData,
            repository,
            prNumber: 42,
            lastCommit,
        });
        expect(
            codeManagementService.getPullRequestFilesAtCommit,
        ).not.toHaveBeenCalled();
    });

    it('keeps [] as nothing new, without a fallback', async () => {
        const { service, codeManagementService } = makeService({
            sinceLastCommit: [],
        });

        await expect(metadata(service, lastCommit)).resolves.toEqual([]);
        expect(
            codeManagementService.getPullRequestFilesAtCommit,
        ).not.toHaveBeenCalled();
        expect(
            codeManagementService.getFilesByPullRequestId,
        ).not.toHaveBeenCalled();
    });

    it('reads what is new from the PR diff at the last reviewed commit', async () => {
        const { service, codeManagementService, logger } = makeService({
            sinceLastCommit: null,
            atCommit: [own],
            prFiles: [ownNow],
        });

        const files = await metadata(service, lastCommit);

        expect(
            codeManagementService.getPullRequestFilesAtCommit,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: orgData,
            repository,
            prNumber: 42,
            baseBranch: 'main',
            headSha: 'reviewed-sha',
        });
        expect(files).toEqual([
            expect.objectContaining({
                filename: 'src/own.ts',
                patch: expect.stringContaining('+c'),
            }),
        ]);
        expect(files[0].patch).not.toContain('+b');
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    reason: 'incremental_diff_unavailable',
                    fallback: 'interdiff',
                }),
            }),
        );
    });

    it('reads the whole PR when the push removed a change the last review saw', async () => {
        const reviewed = {
            filename: 'src/pay.ts',
            patch: '@@ -1,3 +1,5 @@\n function pay(order) {\n+    if (!order) return;\n+    log(order.id);\n     charge(order);\n }',
        };
        const guardRemoved = {
            filename: 'src/pay.ts',
            patch: '@@ -1,3 +1,4 @@\n function pay(order) {\n+    log(order.id);\n     charge(order);\n }',
        };
        const { service, codeManagementService, logger } = makeService({
            sinceLastCommit: null,
            atCommit: [reviewed],
            prFiles: [guardRemoved],
        });

        await expect(metadata(service, lastCommit)).resolves.toEqual([
            guardRemoved,
        ]);
        // The interdiff already read the whole PR; it is not read twice.
        expect(
            codeManagementService.getFilesByPullRequestId,
        ).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    reason: 'incremental_diff_unavailable',
                    fallback: 'full',
                    revertedFiles: 1,
                }),
            }),
        );
    });

    it('reads the whole PR when the PR was retargeted since the last review', async () => {
        const { service, codeManagementService, logger } = makeService({
            sinceLastCommit: null,
            atCommit: [own],
            prFiles: [ownNow],
        });

        // The earlier diff would be read against the new base branch.
        const files = await service.getChangedFilesMetadata(
            orgData,
            repository,
            pullRequest,
            lastCommit,
            'develop',
        );

        expect(files).toEqual([ownNow]);
        expect(
            codeManagementService.getPullRequestFilesAtCommit,
        ).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    fallback: 'full',
                    retargeted: true,
                }),
            }),
        );
    });

    it('keeps the interdiff when the last review saw the same base branch', async () => {
        const { service, codeManagementService } = makeService({
            sinceLastCommit: null,
            atCommit: [own],
            prFiles: [ownNow],
        });

        await service.getChangedFilesMetadata(
            orgData,
            repository,
            pullRequest,
            lastCommit,
            'main',
        );

        expect(
            codeManagementService.getPullRequestFilesAtCommit,
        ).toHaveBeenCalledTimes(1);
    });

    it('accepts the last reviewed commit as a bare sha', async () => {
        const { service, codeManagementService } = makeService({
            sinceLastCommit: null,
            atCommit: [own],
            prFiles: [ownNow],
        });

        await metadata(service, 'reviewed-sha');

        // Providers read `lastCommit.sha`; a bare sha would read as no base.
        expect(
            codeManagementService.getChangedFilesSinceLastCommit,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ lastCommit: { sha: 'reviewed-sha' } }),
        );
        expect(
            codeManagementService.getPullRequestFilesAtCommit,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ headSha: 'reviewed-sha' }),
        );
    });

    it('reads the whole PR when the earlier PR diff is unavailable too', async () => {
        const { service, logger } = makeService({
            sinceLastCommit: null,
            atCommit: null,
            prFiles: [ownNow],
        });

        await expect(metadata(service, lastCommit)).resolves.toEqual([ownNow]);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    reason: 'incremental_diff_unavailable',
                    fallback: 'full',
                }),
            }),
        );
    });

    it('throws when the whole PR cannot be read either, instead of reading as nothing new', async () => {
        const { service } = makeService({
            sinceLastCommit: null,
            atCommit: null,
            prFiles: null,
        });

        await expect(metadata(service, lastCommit)).rejects.toThrow('PR#42');
    });

    it('throws when the whole-PR fallback comes back empty: readers answer an unreadable list with []', async () => {
        const { service } = makeService({
            sinceLastCommit: null,
            atCommit: null,
            prFiles: [],
        });

        await expect(metadata(service, lastCommit)).rejects.toThrow('PR#42');
    });

    it('falls back the same way for getChangedFiles', async () => {
        const { service } = makeService({
            sinceLastCommit: null,
            atCommit: null,
            prFiles: [ownNow],
        });

        const files = await service.getChangedFiles(
            orgData,
            repository,
            pullRequest,
            [],
            lastCommit,
        );

        expect(files.map((f) => f.filename)).toEqual(['src/own.ts']);
    });
});
