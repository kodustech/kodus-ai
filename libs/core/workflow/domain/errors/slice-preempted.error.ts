export const SLICE_PREEMPTED_CLASSIFICATION = 'SLICE_PREEMPTED';

/**
 * The parent aborted this slice (lost inbox claim or drain) so the child
 * must release the sandbox, record spend, leave the scan RUNNING, and
 * exit non-zero. Distinct from JobAbortedError, which fails the scan.
 */
export class SlicePreemptedError extends Error {
    readonly classification = SLICE_PREEMPTED_CLASSIFICATION;

    constructor(message = 'Security-scan slice preempted') {
        super(message);
        this.name = 'SlicePreemptedError';
    }
}

export function isSlicePreemptedError(error: unknown): boolean {
    if (error instanceof SlicePreemptedError) {
        return true;
    }
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: string; classification?: string }).name ===
            'SlicePreemptedError'
    );
}
