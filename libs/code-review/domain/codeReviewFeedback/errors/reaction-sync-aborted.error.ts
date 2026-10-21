import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

import { ICollectedReaction } from '../interfaces/codeReviewFeedback.interface';

/**
 * Raised when a reaction sync run gives up because the git provider started
 * refusing the request rate.
 *
 * Extends `RateLimitError` so `RabbitMQErrorHandler` republishes the message
 * with a reset-aligned delay instead of the generic backoff curve, and carries
 * whatever was already collected so the caller can still persist it — an
 * aborted run should lose the remaining work, not the work it already did.
 */
export class ReactionSyncAbortedError extends RateLimitError {
    readonly partialReactions: ICollectedReaction[];

    constructor(params: {
        resetAt: Date;
        message: string;
        partialReactions: ICollectedReaction[];
        context?: RateLimitError['context'];
    }) {
        super({
            resetAt: params.resetAt,
            message: params.message,
            context: params.context,
        });
        this.name = 'ReactionSyncAbortedError';
        this.partialReactions = params.partialReactions;
    }
}
