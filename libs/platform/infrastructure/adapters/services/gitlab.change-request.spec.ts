import { GitlabService } from './gitlab.service';

const REASON = 'The critical findings behind this request are resolved.';
const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'acme/api' },
    prNumber: 7,
    reason: REASON,
};
const NOTE = 'Kody takes this request back once the findings above are resolved.';

/** The service without its constructor: only what a test hands it. */
const make = <T extends object>(
    cls: { prototype: T },
    overrides: Record<string, unknown>,
) => {
    const service = Object.create(cls.prototype) as T;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    for (const [key, value] of Object.entries({ logger, ...overrides })) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

const build = (discussion: unknown = { id: 'd-1' }) => {
    const create = jest.fn().mockResolvedValue(discussion);
    const unapprove = jest.fn().mockResolvedValue({});
    const service = make(GitlabService, {
        getAuthDetails: jest.fn().mockResolvedValue({}),
        instanceGitlabApi: () => ({
            MergeRequestApprovals: { unapprove },
            MergeRequestDiscussions: { create },
        }),
        getListOfCriticalIssues: () => '- one critical issue',
    });
    return { service: service as any, create, unapprove };
};
const request = {
    organizationAndTeamData: params.organizationAndTeamData,
    repository: params.repository,
    prNumber: 7,
    criticalComments: [{}],
};

// On GitLab the request leaves no review state: it IS the discussion Kody
// opens. Handing back its id is what lets it be resolved later.
describe('GitlabService.requestChangesPullRequest', () => {
    it('opens the discussion saying how it leaves, and hands back its id', async () => {
        const { service, create } = build();

        await expect(service.requestChangesPullRequest(request)).resolves.toEqual({
            summaryCommentId: 'd-1',
        });
        expect(create).toHaveBeenCalledWith(
            'repo-1',
            7,
            `# Found critical issues please review the requested changes\n\n- one critical issue\n\n${NOTE}`,
        );
    });

    it.each([[null], [{}]])(
        'hands back nothing when GitLab returns no discussion id (%p)',
        async (discussion) => {
            const { service } = build(discussion);

            await expect(
                service.requestChangesPullRequest(request),
            ).resolves.toBeUndefined();
        },
    );

    it('has nothing of its own to withdraw: resolving the discussion is the withdrawal', () => {
        expect(
            (GitlabService.prototype as any).dismissOwnPullRequestChangeRequests,
        ).toBeUndefined();
    });
});
