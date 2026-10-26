import { BitbucketService } from './bitbucket.service';

describe('BitbucketService.getPullRequestFilesAtCommit', () => {
    it('forwards to the Cloud or Data Center implementation', async () => {
        const service = new BitbucketService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
        const files = [{ filename: 'a.ts' }];
        const impl = {
            getPullRequestFilesAtCommit: jest.fn().mockResolvedValue(files),
        };
        jest.spyOn(service as any, 'getImplementation').mockResolvedValue(impl);
        const params = {
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            repository: { id: 'r', name: 'repo' },
            prNumber: 1,
            baseBranch: 'main',
            headSha: 'old',
        };

        await expect(service.getPullRequestFilesAtCommit(params)).resolves.toBe(
            files,
        );
        expect(impl.getPullRequestFilesAtCommit).toHaveBeenCalledWith(params);
    });
});
