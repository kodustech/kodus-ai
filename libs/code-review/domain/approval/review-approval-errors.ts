import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { SUMMARY_GENERATION_FAILED_REASON } from '@libs/code-review/pipeline/constants/error-reasons';

export type ReviewErrorLike = {
    severity?: 'critical' | 'partial';
    metadata?: { reason?: string };
};

/**
 * A failed PR summary is reported as a `partial` error, but the review it
 * would gate has already been posted by the time it happens: the failure only
 * means the recap is missing, not that the findings are wrong (#1844).
 */
export const isExemptFromApproval = (error: ReviewErrorLike): boolean =>
    error?.metadata?.reason === SUMMARY_GENERATION_FAILED_REASON;

/**
 * The one rule for whether the errors of a review block automatic approval.
 * The pipeline and the approval cron used to answer it separately, and a
 * summary-only partial error therefore blocked the cron while the pipeline
 * approved (#2408).
 */
export const reviewErrorsBlockApproval = (
    errors: ReviewErrorLike[] | undefined | null,
): boolean =>
    (errors ?? []).some(
        (error) =>
            !isExemptFromApproval(error) &&
            ((error?.severity ?? 'critical') === 'critical' ||
                error?.severity === 'partial'),
    );

export type ReviewExecutionLike =
    | {
          status?: AutomationStatus;
          dataExecution?: { reviewApprovalBlocked?: boolean };
      }
    | null
    | undefined;

/**
 * Whether a stored execution can back an approval. Executions written before
 * the marker existed carry `undefined`, which stays blocking: a partial review
 * must not start approving because a field is missing.
 */
export const reviewExecutionAllowsApproval = (
    execution: ReviewExecutionLike,
): boolean =>
    execution?.status === AutomationStatus.SUCCESS ||
    (execution?.status === AutomationStatus.PARTIAL_ERROR &&
        execution?.dataExecution?.reviewApprovalBlocked === false);

/** The same rule from the other side, for the branches that gate on partial. */
export const partialReviewBlocksApproval = (
    execution: ReviewExecutionLike,
): boolean =>
    execution?.status === AutomationStatus.PARTIAL_ERROR &&
    !reviewExecutionAllowsApproval(execution);
