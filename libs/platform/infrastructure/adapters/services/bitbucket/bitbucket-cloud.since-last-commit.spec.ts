import { BitbucketCloudService } from './bitbucket-cloud.service';

/** #2268: a failed incremental read falls back to a fuller review, so a
 *  rate limit has to surface instead of reading as a failed read. */
describe('BitbucketCloudService.getChangedFilesSinceLastCommit — errors', () => {
    const makeService = (getRepoById: jest.Mock) => {
        const service = Object.create(
            BitbucketCloudService.prototype,
        ) as BitbucketCloudService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
        jest.spyOn(service as any, 'getRepoById').mockImplementation(
            getRepoById,
        );
        jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({});
        return service;
    };

    const read = (service: BitbucketCloudService) =>
        service.getChangedFilesSinceLastCommit({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: 'r1', name: 'api' },
            prNumber: 7,
            lastCommit: { sha: 'reviewed-sha' },
        });

    it('rethrows a 429', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue({ status: 429 }),
        );

        await expect(read(service)).rejects.toMatchObject({ status: 429 });
    });

    it('returns null for any other failure', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue(new Error('boom')),
        );

        await expect(read(service)).resolves.toBeNull();
    });
});
