import { AzureReposService } from './azureRepos.service';

/**
 * A rate-limited file read is not a missing or unchanged file: both PR
 * listings let the 429 through so the job retries, instead of reviewing
 * part of the PR.
 */
describe('AzureReposService listings under a rate limit', () => {
    const repository = { id: 'repo-1', name: 'api', project: { id: 'p-1' } };
    const org = { organizationId: 'org-1', teamId: 't' };
    const rateLimited = () =>
        Object.assign(new Error('Request failed with status code 429'), {
            response: { status: 429 },
        });

    const makeService = (
        failOn: string,
        failure: () => Error = rateLimited,
    ) => {
        const helper = {
            getPullRequestDetails: jest.fn().mockResolvedValue({
                lastMergeTargetCommit: { commitId: 'base' },
                lastMergeSourceCommit: { commitId: 'head' },
            }),
            getIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
            getChanges: jest.fn().mockResolvedValue([
                { item: { path: '/a.ts' }, changeType: 'edit' },
                { item: { path: '/b.ts' }, changeType: 'edit' },
            ]),
            // The paged commit diff: its changes and whether they are all
            getDiff: jest.fn().mockResolvedValue({
                changes: [
                    {
                        item: { path: '/a.ts', gitObjectType: 'blob' },
                        changeType: 'edit',
                    },
                ],
                allChangesIncluded: true,
            }),
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
        ).mockResolvedValue('p-1');
        const generate = jest
            .spyOn(service as any, '_generateFileDiffForAzure')
            .mockImplementation(async (p: any) => {
                if (p.filePath === failOn) throw failure();
                return {
                    filename: p.filePath,
                    sha: p.targetCommitId,
                    status: 'modified',
                    additions: 1,
                    deletions: 1,
                    changes: 2,
                    patch: '@@ -1 +1 @@\n-a\n+b',
                };
            });
        (service as any).logger = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        return { service, generate };
    };

    it('getFilesByPullRequestId lets a 429 on one file through', async () => {
        const { service, generate } = makeService('/b.ts');

        await expect(
            service.getFilesByPullRequestId({
                organizationAndTeamData: org,
                repository,
                prNumber: 7,
            } as any),
        ).rejects.toMatchObject({ response: { status: 429 } });
        expect(generate).toHaveBeenCalledWith(
            expect.objectContaining({ rethrowRateLimit: true }),
        );
    });

    it('getChangedFilesSinceLastCommit lets a 429 on a file through', async () => {
        const { service, generate } = makeService('/a.ts');

        await expect(
            service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: org,
                repository,
                prNumber: 7,
                lastCommit: { sha: 'last' },
            } as any),
        ).rejects.toMatchObject({ response: { status: 429 } });
        expect(generate).toHaveBeenCalledWith(
            expect.objectContaining({ rethrowRateLimit: true }),
        );
    });

    it('getFilesByPullRequestId drops a file that fails otherwise, and keeps the rest', async () => {
        const { service } = makeService('/b.ts', () => new Error('boom'));

        const files = await service.getFilesByPullRequestId({
            organizationAndTeamData: org,
            repository,
            prNumber: 7,
        } as any);

        expect(files?.map((f: any) => f.filename)).toEqual(['/a.ts']);
    });

    it('getChangedFilesSinceLastCommit answers null for a failure that is not a rate limit', async () => {
        const { service } = makeService('/a.ts', () => new Error('boom'));

        await expect(
            service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: org,
                repository,
                prNumber: 7,
                lastCommit: { sha: 'last' },
            } as any),
        ).resolves.toBeNull();
    });

    it('lets a transport failure through both listings', async () => {
        const fetchFailed = () => new TypeError('fetch failed');

        const since = makeService('/a.ts', fetchFailed).service;
        await expect(
            since.getChangedFilesSinceLastCommit({
                organizationAndTeamData: org,
                repository,
                prNumber: 7,
                lastCommit: { sha: 'last' },
            } as any),
        ).rejects.toThrow('fetch failed');

        const full = makeService('none').service;
        (full as any).azureReposRequestHelper.getChanges.mockRejectedValue(
            fetchFailed(),
        );
        await expect(
            full.getFilesByPullRequestId({
                organizationAndTeamData: org,
                repository,
                prNumber: 7,
            } as any),
        ).rejects.toThrow('fetch failed');
    });
});
