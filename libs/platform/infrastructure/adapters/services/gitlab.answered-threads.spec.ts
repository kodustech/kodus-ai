import { GitlabService } from './gitlab.service';

const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'acme/api' },
    prNumber: 7,
};

const note = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    body: `note ${id}`,
    ...extra,
});

function build(all: jest.Mock) {
    const service = Object.create(GitlabService.prototype) as GitlabService;
    Object.assign(service, {
        logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        getAuthDetails: jest.fn().mockResolvedValue({}),
        instanceGitlabApi: () => ({ MergeRequestDiscussions: { all } }),
    });
    return service;
}

describe('GitlabService.getAnsweredReviewThreadRootIds', () => {
    it('keys an answered discussion by its first note id and its discussion id', async () => {
        const all = jest.fn().mockResolvedValue([
            { id: 'd-answered', notes: [note(1), note(2)] },
            { id: 'd-silent', notes: [note(3)] },
        ]);

        await expect(
            build(all).getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set(['1', 'd-answered']));
        expect(all).toHaveBeenCalledWith('repo-1', 7, expect.any(Object));
    });

    it('does not count system notes as replies', async () => {
        const all = jest
            .fn()
            .mockResolvedValue([
                { id: 'd-1', notes: [note(1), note(2, { system: true })] },
            ]);

        await expect(
            build(all).getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set());
    });

    it('returns null when GitLab cannot be read', async () => {
        const service = build(jest.fn().mockRejectedValue(new Error('500')));

        await expect(
            service.getAnsweredReviewThreadRootIds(params),
        ).resolves.toBeNull();
        expect((service as any).logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
            }),
        );
    });
});
