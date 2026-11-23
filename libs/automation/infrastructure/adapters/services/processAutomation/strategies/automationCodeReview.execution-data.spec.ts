import { SUMMARY_GENERATION_FAILED_REASON } from '@libs/code-review/pipeline/constants/error-reasons';
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

    it('records a summary-only partial error as not blocking approval', () => {
        const data = build({
            errors: [
                {
                    severity: 'partial',
                    metadata: { reason: SUMMARY_GENERATION_FAILED_REASON },
                },
            ],
        });

        expect(data.reviewApprovalBlocked).toBe(false);
    });

    it('records any other partial error as blocking', () => {
        const data = build({
            errors: [
                {
                    severity: 'partial',
                    metadata: { reason: 'risk_assessment' },
                },
            ],
        });

        expect(data.reviewApprovalBlocked).toBe(true);
    });

    it('leaves the marker off a result that carries no errors', () => {
        expect(build({})).not.toHaveProperty('reviewApprovalBlocked');
    });
});
