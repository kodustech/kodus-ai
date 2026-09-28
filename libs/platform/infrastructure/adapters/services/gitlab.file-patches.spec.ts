import { GitlabService } from './gitlab.service';

/**
 * GitLab's `/diffs` view is collapsed and size-limited: past
 * `diff_max_patch_bytes` an entry arrives with `collapsed` or `too_large` set
 * and an EMPTY `diff` — routine for a lockfile bump, which is the change a
 * dependency scan most needs to see. Reading the raw diffs bypasses that.
 */
describe('GitlabService — getFilePatches', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { id: '42', owner: 'acme', name: 'widget-api' };

    const makeService = (showChanges: jest.Mock, authDetail: unknown = {}) => {
        const service = Object.create(GitlabService.prototype) as GitlabService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });

        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue(authDetail);

        jest.spyOn(
            service as unknown as { instanceGitlabApi: () => unknown },
            'instanceGitlabApi',
        ).mockReturnValue({ MergeRequests: { showChanges } });

        return service;
    };

    it('asks for the raw diffs, not the collapsed view', async () => {
        const showChanges = jest.fn().mockResolvedValue({ changes: [] });

        await makeService(showChanges).getFilePatches({
            organizationAndTeamData,
            repository,
            prNumber: 7,
            paths: ['yarn.lock'],
        });

        expect(showChanges).toHaveBeenCalledWith('42', 7, {
            accessRawDiffs: true,
        });
    });

    it('returns the hunks for the requested paths only', async () => {
        const showChanges = jest.fn().mockResolvedValue({
            changes: [
                { new_path: 'yarn.lock', diff: '@@ -1 +1 @@\n-a\n+b' },
                { new_path: 'src/app.ts', diff: '@@ -2 +2 @@\n-c\n+d' },
            ],
        });

        const out = await makeService(showChanges).getFilePatches({
            organizationAndTeamData,
            repository,
            prNumber: 7,
            paths: ['yarn.lock'],
        });

        expect(out).toEqual([
            { path: 'yarn.lock', patch: '@@ -1 +1 @@\n-a\n+b' },
        ]);
    });

    it('skips an entry whose diff is still empty rather than inventing one', async () => {
        // A collapsed entry the raw read could not fill either.
        const showChanges = jest.fn().mockResolvedValue({
            changes: [{ new_path: 'yarn.lock', diff: '', collapsed: true }],
        });

        const out = await makeService(showChanges).getFilePatches({
            organizationAndTeamData,
            repository,
            prNumber: 7,
            paths: ['yarn.lock'],
        });

        expect(out).toEqual([]);
    });

    it('degrades to no recovery when the read fails', async () => {
        const showChanges = jest.fn().mockRejectedValue(new Error('boom'));

        await expect(
            makeService(showChanges).getFilePatches({
                organizationAndTeamData,
                repository,
                prNumber: 7,
                paths: ['yarn.lock'],
            }),
        ).resolves.toEqual([]);
    });

    it('does not call the API when nothing is missing', async () => {
        const showChanges = jest.fn();

        const out = await makeService(showChanges).getFilePatches({
            organizationAndTeamData,
            repository,
            prNumber: 7,
            paths: [],
        });

        expect(out).toEqual([]);
        expect(showChanges).not.toHaveBeenCalled();
    });
});
