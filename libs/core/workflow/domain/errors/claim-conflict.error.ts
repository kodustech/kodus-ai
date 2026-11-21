/**
 * Inbox claim failed because another worker still holds the message in
 * PROCESSING. This is not a processing failure: the work may still be
 * running, or the holder may have died. RabbitMQErrorHandler republishes
 * with a delay and does not increment x-retry-count, so a dead holder's
 * redelivery is not burned into the DLQ.
 */
export const CLAIM_CONFLICT_CLASSIFICATION = 'CLAIM_HELD';

/** Delay before the held message is offered again. */
export const CLAIM_CONFLICT_REQUEUE_DELAY_MS = 20_000;

export class ClaimConflictError extends Error {
    readonly errorClassification = CLAIM_CONFLICT_CLASSIFICATION;
    readonly requeueDelayMs: number;
    /**
     * Give the delivery back to the broker (nack with requeue) instead of
     * republishing a delayed copy: for work this worker started and was
     * stopped, so nothing but the broker's own requeue stands between the
     * message and the next worker.
     */
    readonly returnToQueue: boolean;

    constructor(
        message = 'Message already claimed but not finished',
        requeueDelayMs: number = CLAIM_CONFLICT_REQUEUE_DELAY_MS,
        options: { returnToQueue?: boolean } = {},
    ) {
        super(message);
        this.name = 'ClaimConflictError';
        this.requeueDelayMs = requeueDelayMs;
        this.returnToQueue = options.returnToQueue === true;
    }
}

export function isClaimConflictError(
    error: unknown,
): error is ClaimConflictError {
    if (error instanceof ClaimConflictError) return true;
    if (typeof error !== 'object' || error === null) return false;
    return (
        (error as { errorClassification?: unknown }).errorClassification ===
        CLAIM_CONFLICT_CLASSIFICATION
    );
}
