import { AutomationCodeReviewService } from './automationCodeReview';

/**
 * The approval cron reads the latest execution, not the pipeline context, so
 * the "does this partial error block approval" answer has to travel with the
 * execution. Without it a summary-only partial review is stored as
 * PARTIAL_ERROR and the cron holds a review the pipeline approved (#2408).
 */
describe('AutomationCodeReviewService — reviewApprovalBlocked', () => {
    const service = Object.create(
        AutomationCodeReviewService.prototype,
    ) as AutomationCodeReviewService;

    const payload = {
        platformType: 'GITHUB',
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        pullRequest: { number: 7 },
        repository: { id: '42' },
    };

    const build = (result: unknown) =>
        (
            service as unknown as {
                _buildExecutionData: (
                    payload: unknown,
                    result: unknown,
                ) => Record<string, unknown>;
            }
        )._buildExecutionData(payload, result);

    it('persists the handler’s non-blocking answer', () => {
        const data = build({ reviewApprovalBlocked: false });

        expect(data.reviewApprovalBlocked).toBe(false);
    });

    it('persists a blocking answer', () => {
        const data = build({ reviewApprovalBlocked: true });

        expect(data.reviewApprovalBlocked).toBe(true);
    });

    it('leaves the marker off a result that does not carry it', () => {
        expect(build({})).not.toHaveProperty('reviewApprovalBlocked');
    });
});
