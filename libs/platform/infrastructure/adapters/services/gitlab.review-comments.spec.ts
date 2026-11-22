import { GitlabService } from './gitlab.service';

/**
 * Marking a suggestion implemented resolves the discussion that carries it,
 * by matching the stored comment id against the MR's discussions. Kody's own
 * discussions used to be dropped from that read, so the match found nothing
 * and the thread stayed open (#2443).
 *
 * The exclusion stays the default for the approval guards: they only ask
 * whether a finding is still open, and a comment that is absent already reads
 * as open there.
 */
describe('GitlabService — getPullRequestReviewComments', () => {
    const params = {
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: '42', name: 'acme/api' },
        prNumber: 7,
    };

    const discussion = (
        id: string,
        noteId: number,
        body: string,
        resolved = false,
    ) => ({
        id,
        notes: [
            {
                id: noteId,
                resolvable: true,
                resolved,
                body,
                author: { id: 1, name: 'Kody', username: 'kody' },
                created_at: '2026-11-20T10:00:00Z',
                updated_at: '2026-11-20T10:00:00Z',
            },
        ],
    });

    const humanThread = discussion(
        'disc-human',
        900,
        'Could this helper be shared?',
    );
    const kodyThread = discussion(
        'disc-kody',
        1001,
        '## Code Review Completed! 🔥\n\nTwo findings below.',
    );

    const makeService = () => {
        const service = Object.create(GitlabService.prototype) as GitlabService;
        const api = {
            MergeRequestDiscussions: {
                all: jest.fn().mockResolvedValue([humanThread, kodyThread]),
            },
        };
        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue({});
        jest.spyOn(
            service as unknown as { instanceGitlabApi: () => unknown },
            'instanceGitlabApi',
        ).mockReturnValue(api);
        return { service, api };
    };

    it('returns Kody’s own discussion when the caller asks for it', async () => {
        const { service } = makeService();

        const comments = await service.getPullRequestReviewComments({
            ...params,
            includeKodyComments: true,
        });

        expect(comments).toHaveLength(2);
        expect(comments?.map((comment) => comment.threadId)).toEqual([
            'disc-human',
            'disc-kody',
        ]);
        expect(
            comments?.find((comment) => comment.threadId === 'disc-kody'),
        ).toMatchObject({ id: 1001, isResolved: false });
    });

    it('leaves Kody’s discussion out by default', async () => {
        const { service } = makeService();

        const comments = await service.getPullRequestReviewComments(params);

        expect(comments).toHaveLength(1);
        expect(comments?.[0].threadId).toBe('disc-human');
    });
});
