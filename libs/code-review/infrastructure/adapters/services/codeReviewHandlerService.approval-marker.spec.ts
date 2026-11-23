import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    RISK_ASSESSMENT_FAILED_REASON,
    SUMMARY_GENERATION_FAILED_REASON,
} from '@libs/code-review/pipeline/constants/error-reasons';
import { CodeReviewHandlerService } from './codeReviewHandlerService.service';

/**
 * The automation stores only what the handler returns, and the approval cron
 * only sees the execution status. A summary-only partial review therefore has
 * to carry its "does not block approval" answer out of the handler (#2408).
 */
describe('CodeReviewHandlerService — reviewApprovalBlocked', () => {
    const run = async (reason: string) => {
        const execute = jest.fn(async (context) => ({
            ...context,
            lastAnalyzedCommit: { sha: 'head' },
            errors: [
                {
                    stage: 'FinishCommentsStage',
                    error: new Error('auxiliary stage failed'),
                    severity: 'partial',
                    metadata: { reason },
                },
            ],
        }));
        const handler = new CodeReviewHandlerService(
            { getPipeline: () => ({ execute }) } as any,
            {
                addReactionToPR: jest.fn(),
                removeReactionsFromPR: jest.fn(),
            } as any,
            {
                findByKey: jest
                    .fn()
                    .mockResolvedValue({ configValue: 'already-captured' }),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            { consumeTrialReviewCreditOnSuccess: jest.fn() } as any,
        );

        return handler.handlePullRequest(
            { organizationId: 'org', teamId: 'team' },
            { id: 'repo', name: 'repo' },
            'main',
            { number: 1 },
            PlatformType.GITHUB,
            'automation',
            'automation',
            'opened',
            'execution',
        );
    };

    it('reports a summary-only partial review as not blocking approval', async () => {
        const result = (await run(SUMMARY_GENERATION_FAILED_REASON)) as any;

        expect(result.statusInfo.status).toBe(AutomationStatus.PARTIAL_ERROR);
        expect(result.reviewApprovalBlocked).toBe(false);
    });

    it('reports a risk-assessment partial error as blocking', async () => {
        const result = (await run(RISK_ASSESSMENT_FAILED_REASON)) as any;

        expect(result.statusInfo.status).toBe(AutomationStatus.PARTIAL_ERROR);
        expect(result.reviewApprovalBlocked).toBe(true);
    });
});
