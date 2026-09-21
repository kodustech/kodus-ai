import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * Regression coverage for a prod TypeError (2026-09-17, 10 occurrences):
 * "Cannot read properties of undefined (reading 'commentId')" at
 * getCriticalIssuesSummaryArray, crashing the whole "request changes on
 * critical issues" stage (RequestChangesOrApproveStage).
 *
 * Both `CommentResult.codeReviewFeedbackData` and `Comment.suggestion` are
 * declared optional on their own types (a comment whose GitHub post failed
 * has no feedback data yet), and `OneSentenceSummaryItem.id` is itself
 * optional — the caller (getListOfCriticalIssues) already renders a linkless
 * bullet when id is missing. The map callback read both without `?.`.
 */
describe('GithubService.getCriticalIssuesSummaryArray / getListOfCriticalIssues', () => {
    const service = new GithubService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { get: jest.fn() } as unknown as ConfigService,
    );

    it('does not throw when a comment has no codeReviewFeedbackData', () => {
        const criticalComments = [
            {
                comment: { path: 'x.ts', suggestion: { oneSentenceSummary: 'Null check missing' } },
                deliveryStatus: 'failed',
                // no codeReviewFeedbackData — the comment failed to post
            },
        ] as any;

        expect(() =>
            service.getCriticalIssuesSummaryArray(criticalComments),
        ).not.toThrow();

        const result = service.getCriticalIssuesSummaryArray(criticalComments);
        expect(result).toEqual([
            { id: undefined, oneSentenceSummary: 'Null check missing' },
        ]);
    });

    it('does not throw when a comment has no suggestion', () => {
        const criticalComments = [
            {
                comment: { path: 'x.ts' },
                deliveryStatus: 'success',
                codeReviewFeedbackData: {
                    commentId: 42,
                    pullRequestReviewId: 1,
                    suggestionId: 's1',
                },
            },
        ] as any;

        expect(() =>
            service.getCriticalIssuesSummaryArray(criticalComments),
        ).not.toThrow();

        const result = service.getCriticalIssuesSummaryArray(criticalComments);
        expect(result).toEqual([{ id: 42, oneSentenceSummary: '' }]);
    });

    it('getListOfCriticalIssues renders a linkless bullet instead of crashing end-to-end', () => {
        const criticalComments = [
            {
                comment: { path: 'x.ts', suggestion: { oneSentenceSummary: 'Race condition' } },
                deliveryStatus: 'failed',
            },
        ] as any;

        expect(() =>
            service.getListOfCriticalIssues({
                criticalComments,
                orgName: 'acme',
                repository: { name: 'repo' } as any,
                prNumber: 7,
            }),
        ).not.toThrow();

        expect(
            service.getListOfCriticalIssues({
                criticalComments,
                orgName: 'acme',
                repository: { name: 'repo' } as any,
                prNumber: 7,
            }),
        ).toBe('- Race condition');
    });

    it('still links normally when both fields are present', () => {
        const criticalComments = [
            {
                comment: { path: 'x.ts', suggestion: { oneSentenceSummary: 'Race condition' } },
                deliveryStatus: 'success',
                codeReviewFeedbackData: {
                    commentId: 99,
                    pullRequestReviewId: 1,
                    suggestionId: 's1',
                },
            },
        ] as any;

        const result = service.getListOfCriticalIssues({
            criticalComments,
            orgName: 'acme',
            repository: { name: 'repo' } as any,
            prNumber: 7,
        });

        expect(result).toContain('discussion_r99');
        expect(result).toContain('Race condition');
    });
});
