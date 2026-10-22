import { ForgejoService } from './forgejo.service';

/**
 * #2037: Forgejo's compare API lists files without patches, so the PR diff at
 * an earlier head cannot be rebuilt. A rebase there keeps the full review,
 * which is what every Forgejo push already gets.
 */
describe('ForgejoService.getPullRequestFilesAtCommit', () => {
    it('reports the earlier diff as unavailable', async () => {
        const service = Object.create(ForgejoService.prototype) as ForgejoService;
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        Object.defineProperty(service, 'logger', { value: logger });

        await expect(
            service.getPullRequestFilesAtCommit({
                organizationAndTeamData: { organizationId: 'o', teamId: 't' },
                repository: { id: 'r', name: 'acme/api' },
                prNumber: 7,
                baseBranch: 'main',
                headSha: 'old-head',
            }),
        ).resolves.toBeNull();
        expect(logger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    prNumber: 7,
                    reason: 'not_supported',
                }),
            }),
        );
    });
});
