import { AzureReposService } from './azureRepos.service';

/**
 * #2037: the PR diff as it stood at an earlier head, read from the PR
 * iteration that had that head as its source.
 */
describe('AzureReposService.getPullRequestFilesAtCommit', () => {
    const repository = {
        id: 'repo-1',
        name: 'api',
        project: { id: 'project-1' },
    };
    const org = { organizationId: 'org-1', teamId: 't' };

    const makeService = (iterations: unknown[], changes: unknown[]) => {
        const helper = {
            getIterations: jest.fn().mockResolvedValue(iterations),
            getChanges: jest.fn().mockResolvedValue(changes),
        };
        const service = new AzureReposService(
            {} as any,
            {} as any,
            {} as any,
            helper as any,
            {} as any,
            undefined,
        );
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'o',
            token: 't',
        });
        jest.spyOn(
            service as any,
            'getProjectIdFromRepository',
        ).mockResolvedValue('project-1');
        const generate = jest
            .spyOn(service as any, '_generateFileDiffForAzure')
            .mockImplementation(async (p: any) => ({
                filename: p.filePath,
                sha: p.targetCommitId,
                status: 'modified',
                additions: 1,
                deletions: 1,
                changes: 2,
                patch: '@@ -1 +1 @@\n-a\n+b',
                content: '',
            }));
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (service as any).logger = logger;
        return { service, helper, generate, logger };
    };

    const read = (service: AzureReposService, headSha = 'old-head') =>
        service.getPullRequestFilesAtCommit({
            organizationAndTeamData: org,
            repository,
            prNumber: 7,
            baseBranch: 'refs/heads/main',
            headSha,
        });

    const iterations = [
        {
            id: 1,
            sourceRefCommit: { commitId: 'old-head' },
            commonRefCommit: { commitId: 'old-base' },
            targetRefCommit: { commitId: 'old-main-tip' },
        },
        {
            id: 2,
            sourceRefCommit: { commitId: 'new-head' },
            commonRefCommit: { commitId: 'new-base' },
        },
    ];

    it('diffs each file of that iteration from its merge base to the earlier head', async () => {
        const { service, helper, generate } = makeService(iterations, [
            { item: { path: '/src/a.ts' }, changeType: 'edit' },
        ]);

        const files = await read(service);

        expect(helper.getChanges).toHaveBeenCalledWith(
            expect.objectContaining({ pullRequestId: 7, iterationId: 1 }),
        );
        expect(generate).toHaveBeenCalledWith(
            expect.objectContaining({
                filePath: '/src/a.ts',
                baseCommitId: 'old-base',
                targetCommitId: 'old-head',
                changeType: 'edit',
            }),
        );
        expect(files).toEqual([
            expect.objectContaining({
                filename: '/src/a.ts',
                patch: '@@ -1 +1 @@\n-a\n+b',
            }),
        ]);
    });

    it('returns null when no iteration had that head', async () => {
        const { service, logger } = makeService(iterations, []);

        await expect(read(service, 'unknown')).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    headSha: 'unknown',
                    reason: 'compare_failed',
                }),
            }),
        );
    });

    it('returns null when a file diff could not be built, since the diff would be partial', async () => {
        const { service, generate } = makeService(iterations, [
            { item: { path: '/src/a.ts' }, changeType: 'edit' },
            { item: { path: '/src/b.ts' }, changeType: 'edit' },
        ]);
        generate.mockResolvedValueOnce(null);

        await expect(read(service)).resolves.toBeNull();
    });
});
