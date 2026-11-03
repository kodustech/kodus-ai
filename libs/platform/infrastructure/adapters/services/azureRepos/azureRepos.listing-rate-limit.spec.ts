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

    const makeService = (failOn: string) => {
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
            getDiff: jest.fn().mockResolvedValue([
                {
                    item: { path: '/a.ts', gitObjectType: 'blob' },
                    changeType: 'edit',
                },
            ]),
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
                if (p.filePath === failOn) throw rateLimited();
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
});
