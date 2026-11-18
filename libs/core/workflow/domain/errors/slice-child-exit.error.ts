/**
 * The slice child process ended with a non-zero code or a signal.
 * The parent classifies preempted vs crash from `code` / `signal`, not
 * from the error message.
 */
export class SliceChildExitError extends Error {
    readonly code: number | null;
    readonly signal: string | null;
    readonly jobId: string;

    constructor(params: {
        jobId: string;
        code: number | null;
        signal: string | null;
    }) {
        super(
            `Security scan slice child exited ${params.code ?? params.signal} for job ${params.jobId}`,
        );
        this.name = 'SliceChildExitError';
        this.code = params.code;
        this.signal = params.signal;
        this.jobId = params.jobId;
    }
}

export function isSliceChildExitError(
    error: unknown,
): error is SliceChildExitError {
    if (error instanceof SliceChildExitError) {
        return true;
    }
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: string }).name === 'SliceChildExitError'
    );
}
