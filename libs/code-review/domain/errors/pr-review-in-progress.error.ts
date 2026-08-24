import type { CommandReviewFeedbackTarget } from '@libs/code-review/infrastructure/adapters/services/codeReviewHandlerService.service';

/**
 * Thrown when a user-issued `@kody review` cannot start because another run
 * already holds the PR — either the distributed lock or an in-flight
 * execution row.
 *
 * Only command origins throw. An automation losing the same race is
 * genuinely redundant and is still dropped, quietly.
 *
 * Returning instead of throwing is what made the request vanish (#1700):
 * the caller chain ignores the returned string and marks the job COMPLETED,
 * so nothing retries and nothing reaches the PR. Throwing hands the
 * decision to the job processor, which can reschedule the job for after
 * the holder finishes.
 */
export class PrReviewInProgressError extends Error {
    readonly name = 'PrReviewInProgressError';

    /** Which gate refused it — for logging and metrics only. */
    readonly gate: 'lock' | 'execution';

    /** Everything needed to answer the user on the PR, if we give up. */
    readonly target: CommandReviewFeedbackTarget;

    constructor(params: {
        gate: 'lock' | 'execution';
        target: CommandReviewFeedbackTarget;
        message?: string;
    }) {
        super(
            params.message ??
                `Code review already in progress for PR#${params.target?.pullRequest?.number}`,
        );
        this.gate = params.gate;
        this.target = params.target;
    }
}

/**
 * Duck-typed so an error that crossed a serialization boundary is still
 * recognized, matching how the other workflow errors are detected.
 */
export function isPrReviewInProgressError(
    error: unknown,
): error is PrReviewInProgressError {
    if (error instanceof PrReviewInProgressError) return true;

    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'PrReviewInProgressError' &&
        typeof (error as { target?: unknown }).target === 'object'
    );
}
