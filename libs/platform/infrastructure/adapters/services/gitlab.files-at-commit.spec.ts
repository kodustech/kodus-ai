import { GitlabService } from './gitlab.service';

/**
 * #2037: the MR diff as it stood at an earlier head, so a rebase can be
 * compared with what was already reviewed.
 */
describe('GitlabService.getPullRequestFilesAtCommit', () => {
    const makeService = (compare: jest.Mock) => {
        const service = Object.create(GitlabService.prototype) as GitlabService;
        const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
        Object.defineProperty(service, 'logger', { value: logger });
        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue({});
        jest.spyOn(
            service as unknown as { instanceGitlabApi: () => unknown },
            'instanceGitlabApi',
        ).mockReturnValue({ Repositories: { compare } });
        return { service, logger };
    };

    const read = (service: GitlabService) =>
        service.getPullRequestFilesAtCommit({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: '42', name: 'widget-api' },
            prNumber: 7,
            baseBranch: 'main',
            headSha: 'old-head',
        });

    it('compares the target branch with the earlier head from their merge base', async () => {
        const compare = jest.fn().mockResolvedValue({
            diffs: [
                {
                    old_path: 'src/a.ts',
                    new_path: 'src/b.ts',
                    renamed_file: true,
                    diff: '@@ -1 +1,2 @@\n a\n+b\n',
                },
                {
                    old_path: 'gone.ts',
                    new_path: 'gone.ts',
                    deleted_file: true,
                    diff: '@@ -1 +0,0 @@\n-x\n',
                },
            ],
        });
        const { service } = makeService(compare);

        const files = await read(service);

        expect(compare).toHaveBeenCalledWith('42', 'main', 'old-head', {
            straight: false,
        });
        expect(files).toEqual([
            expect.objectContaining({
                filename: 'src/b.ts',
                previous_filename: 'src/a.ts',
                status: 'renamed',
                additions: 1,
                deletions: 0,
                patch: '@@ -1 +1,2 @@\n a\n+b\n',
            }),
            expect.objectContaining({
                filename: 'gone.ts',
                status: 'removed',
                deletions: 1,
            }),
        ]);
    });

    it('returns null and warns when the earlier head cannot be read', async () => {
        const { service, logger } = makeService(
            jest.fn().mockRejectedValue(new Error('404 Commit Not Found')),
        );

        await expect(read(service)).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    prNumber: 7,
                    headSha: 'old-head',
                    reason: 'compare_failed',
                }),
            }),
        );
    });
});
