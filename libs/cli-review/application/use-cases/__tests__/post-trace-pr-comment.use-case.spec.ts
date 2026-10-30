import {
    PostTracePrCommentUseCase,
    renderTraceComment,
    TRACE_COMMENT_MARKER,
} from '../post-trace-pr-comment.use-case';
import { TraceContextDecision } from '@libs/cli-review/domain/types/trace-context.types';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

const ORG = { organizationId: 'org-1', teamId: 'team-1' };
const REPO = { name: 'kodus-ai', id: 'repo-1' };

function decision(
    overrides: Partial<TraceContextDecision> = {},
): TraceContextDecision {
    return {
        type: 'tradeoff',
        decision: 'Totals are cached rather than recomputed on read',
        rationale: 'Recomputing made the list view quadratic',
        confidence: 0.9,
        scope: ['src/billing'],
        ...overrides,
    };
}

describe('PostTracePrCommentUseCase', () => {
    let codeManagement: {
        getAllCommentsInPullRequest: jest.Mock;
        createIssueComment: jest.Mock;
        updateIssueComment: jest.Mock;
    };
    let useCase: PostTracePrCommentUseCase;

    const input = (decisions: TraceContextDecision[], extra = {}) => ({
        organizationAndTeamData: ORG,
        prNumber: 42,
        repository: REPO,
        decisions,
        ...extra,
    });

    beforeEach(() => {
        codeManagement = {
            getAllCommentsInPullRequest: jest.fn().mockResolvedValue([]),
            createIssueComment: jest.fn().mockResolvedValue({ id: 7 }),
            updateIssueComment: jest.fn().mockResolvedValue({ id: 7 }),
        };
        useCase = new PostTracePrCommentUseCase(codeManagement as any);
    });

    it('posts no comment at all when the PR has no recorded decisions', async () => {
        const outcome = await useCase.execute(input([]));

        expect(outcome).toEqual({ action: 'skipped', reason: 'no-decisions' });
        expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
        expect(codeManagement.updateIssueComment).not.toHaveBeenCalled();
        expect(
            codeManagement.getAllCommentsInPullRequest,
        ).not.toHaveBeenCalled();
    });

    it('treats a blank decision as no decision', async () => {
        const outcome = await useCase.execute(
            input([decision({ decision: '   ' })]),
        );

        expect(outcome).toEqual({ action: 'skipped', reason: 'no-decisions' });
        expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
    });

    it('creates the comment on the first run, carrying the marker', async () => {
        const outcome = await useCase.execute(input([decision()]));

        expect(outcome).toEqual({ action: 'created', commentId: 7 });
        expect(codeManagement.createIssueComment).toHaveBeenCalledTimes(1);

        const body = codeManagement.createIssueComment.mock.calls[0][0].body;
        expect(body).toContain(TRACE_COMMENT_MARKER);
        expect(body).toContain('Totals are cached rather than recomputed');
    });

    it('updates the existing comment in place on a re-run rather than posting again', async () => {
        codeManagement.getAllCommentsInPullRequest.mockResolvedValue([
            { id: 99, body: 'someone else said something' },
            { id: 123, body: `${TRACE_COMMENT_MARKER}\n## Why this changed` },
        ]);

        const outcome = await useCase.execute(input([decision()]));

        expect(outcome).toEqual({ action: 'updated', commentId: 123 });
        expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
        expect(codeManagement.updateIssueComment).toHaveBeenCalledTimes(1);
        expect(
            codeManagement.updateIssueComment.mock.calls[0][0].commentId,
        ).toBe(123);
    });

    it('leaves one comment per PR across repeated runs', async () => {
        const posted: Array<{ id: number; body: string }> = [];
        codeManagement.getAllCommentsInPullRequest.mockImplementation(
            async () => posted,
        );
        codeManagement.createIssueComment.mockImplementation(
            async ({ body }: { body: string }) => {
                const comment = { id: posted.length + 1, body };
                posted.push(comment);
                return comment;
            },
        );
        codeManagement.updateIssueComment.mockImplementation(
            async ({ commentId, body }: { commentId: number; body: string }) => {
                const target = posted.find((entry) => entry.id === commentId)!;
                target.body = body;
                return target;
            },
        );

        await useCase.execute(input([decision()]));
        await useCase.execute(input([decision()]));
        await useCase.execute(
            input([decision({ decision: 'and a newer one' })]),
        );

        expect(posted).toHaveLength(1);
        expect(posted[0].body).toContain('and a newer one');
    });

    it('reads a GitLab-shaped comment body', async () => {
        codeManagement.getAllCommentsInPullRequest.mockResolvedValue([
            { id: 5, note: `${TRACE_COMMENT_MARKER} previous` },
        ]);

        const outcome = await useCase.execute(input([decision()]));

        expect(outcome).toEqual({ action: 'updated', commentId: 5 });
    });

    it('does not post during a dry run', async () => {
        const outcome = await useCase.execute(
            input([decision()], { dryRun: { enabled: true } }),
        );

        expect(outcome).toEqual({ action: 'skipped', reason: 'dry-run' });
        expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
    });

    it('never lets a transport failure escape', async () => {
        codeManagement.getAllCommentsInPullRequest.mockRejectedValue(
            new Error('403 from the provider'),
        );

        const outcome = await useCase.execute(input([decision()]));

        expect(outcome).toEqual({ action: 'skipped', reason: 'error' });
    });
});

describe('renderTraceComment', () => {
    it('starts with the marker so re-runs can find it', () => {
        expect(renderTraceComment([decision()]).startsWith(
            TRACE_COMMENT_MARKER,
        )).toBe(true);
    });

    it('groups decisions by type and renders rationale and scope', () => {
        const body = renderTraceComment([
            decision(),
            decision({
                type: 'convention',
                decision: 'Money is stored in cents',
                rationale: undefined,
                scope: ['src/billing/money.ts'],
            }),
        ]);

        expect(body).toContain('**Tradeoff**');
        expect(body).toContain('**Convention**');
        expect(body).toContain('Recomputing made the list view quadratic');
        expect(body).toContain('`src/billing/money.ts`');
    });
});
