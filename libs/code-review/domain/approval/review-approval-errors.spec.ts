import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import {
    RISK_ASSESSMENT_FAILED_REASON,
    SUMMARY_GENERATION_FAILED_REASON,
} from '@libs/code-review/pipeline/constants/error-reasons';
import {
    partialReviewBlocksApproval,
    reviewErrorsBlockApproval,
    reviewExecutionAllowsApproval,
} from './review-approval-errors';

describe('reviewErrorsBlockApproval', () => {
    it('does not block on a failed PR summary, which is the only exempt error', () => {
        expect(
            reviewErrorsBlockApproval([
                {
                    severity: 'partial',
                    metadata: { reason: SUMMARY_GENERATION_FAILED_REASON },
                },
            ]),
        ).toBe(false);
    });

    it('blocks on any other partial error', () => {
        expect(
            reviewErrorsBlockApproval([
                {
                    severity: 'partial',
                    metadata: { reason: RISK_ASSESSMENT_FAILED_REASON },
                },
            ]),
        ).toBe(true);
    });

    it('blocks on a critical error, including one that carries no severity', () => {
        expect(reviewErrorsBlockApproval([{ severity: 'critical' }])).toBe(
            true,
        );
        expect(reviewErrorsBlockApproval([{}])).toBe(true);
    });

    it('blocks when an exempt summary error comes with a real one', () => {
        expect(
            reviewErrorsBlockApproval([
                {
                    severity: 'partial',
                    metadata: { reason: SUMMARY_GENERATION_FAILED_REASON },
                },
                {
                    severity: 'partial',
                    metadata: { reason: RISK_ASSESSMENT_FAILED_REASON },
                },
            ]),
        ).toBe(true);
    });

    it('does not block a review with no errors', () => {
        expect(reviewErrorsBlockApproval([])).toBe(false);
        expect(reviewErrorsBlockApproval(undefined)).toBe(false);
    });
});

describe('partialReviewBlocksApproval', () => {
    it('lets a summary-only partial execution through once the marker says so', () => {
        expect(
            partialReviewBlocksApproval({
                status: AutomationStatus.PARTIAL_ERROR,
                dataExecution: { reviewApprovalBlocked: false },
            }),
        ).toBe(false);
    });

    it('keeps blocking a partial execution whose errors are real', () => {
        expect(
            partialReviewBlocksApproval({
                status: AutomationStatus.PARTIAL_ERROR,
                dataExecution: { reviewApprovalBlocked: true },
            }),
        ).toBe(true);
    });

    it('keeps blocking an older partial execution that has no marker', () => {
        expect(
            partialReviewBlocksApproval({
                status: AutomationStatus.PARTIAL_ERROR,
                dataExecution: {},
            }),
        ).toBe(true);
        expect(
            partialReviewBlocksApproval({
                status: AutomationStatus.PARTIAL_ERROR,
            }),
        ).toBe(true);
    });

    it('never blocks a success', () => {
        expect(
            partialReviewBlocksApproval({
                status: AutomationStatus.SUCCESS,
                dataExecution: { reviewApprovalBlocked: true },
            }),
        ).toBe(false);
        expect(partialReviewBlocksApproval(null)).toBe(false);
    });
});

describe('reviewExecutionAllowsApproval', () => {
    it('accepts a success', () => {
        expect(
            reviewExecutionAllowsApproval({
                status: AutomationStatus.SUCCESS,
            }),
        ).toBe(true);
    });

    it('accepts a partial review whose only failure was the summary', () => {
        expect(
            reviewExecutionAllowsApproval({
                status: AutomationStatus.PARTIAL_ERROR,
                dataExecution: { reviewApprovalBlocked: false },
            }),
        ).toBe(true);
    });

    it('refuses a real partial, a markerless partial and an error', () => {
        expect(
            reviewExecutionAllowsApproval({
                status: AutomationStatus.PARTIAL_ERROR,
                dataExecution: { reviewApprovalBlocked: true },
            }),
        ).toBe(false);
        expect(
            reviewExecutionAllowsApproval({
                status: AutomationStatus.PARTIAL_ERROR,
            }),
        ).toBe(false);
        expect(
            reviewExecutionAllowsApproval({ status: AutomationStatus.ERROR }),
        ).toBe(false);
        expect(reviewExecutionAllowsApproval(null)).toBe(false);
    });
});
