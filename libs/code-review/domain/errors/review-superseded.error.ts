/**
 * The abort reason given to a running automatic review when a push moves
 * the PR head while it is still reviewing the old one.
 *
 * The run ends without posting, as ERROR with this message, and never
 * records `lastAnalyzedCommit`. The push that superseded it is already
 * deferred by the job processor; when it runs, ValidateNewCommitsStage
 * reads the last SUCCESS execution, so the new run reviews the commits of
 * both pushes together. Nothing is reviewed twice and nothing is missed.
 */
export class ReviewSupersededError extends Error {
    readonly name = 'ReviewSupersededError';

    /** The head the aborted run was reviewing. */
    readonly supersededHeadSha?: string;

    /** The head that superseded it. */
    readonly newHeadSha: string;

    constructor(params: { supersededHeadSha?: string; newHeadSha: string }) {
        super(
            `Superseded by a newer push (${params.newHeadSha.slice(0, 7)}); the new commits are reviewed together with these`,
        );
        this.supersededHeadSha = params.supersededHeadSha;
        this.newHeadSha = params.newHeadSha;
    }
}

export function isReviewSupersededError(
    error: unknown,
): error is ReviewSupersededError {
    if (error instanceof ReviewSupersededError) return true;

    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'ReviewSupersededError'
    );
}
