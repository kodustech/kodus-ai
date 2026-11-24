import { Inject, Injectable, Logger } from '@nestjs/common';

import type {
    DecisionRecorderInput,
    IDecisionRecorder,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import {
    PULL_REQUESTS_SERVICE_TOKEN,
    type IPullRequestsService,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';

/**
 * The outbox adapter: one row per apply transition, in the existing
 * `pull_request_messages` / PR approval-reason delivery store.
 *
 * This is the same write the existing cron performs through
 * `recordApprovalReasonDelivery` (`apps/api/src/cron/CheckIfPRCanBeApproved.cron.ts:2243`),
 * reached through the service rather than through the cron, so the reconciler
 * never depends on the cron and the cron never depends on the reconciler.
 *
 * The `notAfter` semantics carry over unchanged:
 *   - an approve is always recorded (a confirmed approval must never be lost)
 *   - a hold carries a declining deadline, so a late hold post is not
 *     published after the PR has moved on
 */
@Injectable()
export class PrDecisionRecorderService implements IDecisionRecorder {
    private readonly logger = new Logger(PrDecisionRecorderService.name);

    constructor(
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequests: IPullRequestsService,
    ) {}

    async record(input: DecisionRecorderInput): Promise<void> {
        try {
            await this.pullRequests.setApprovalReasonDeliveryFailure(
                input.organizationId,
                input.repositoryId,
                input.prNumber,
                {
                    decision: input.decision,
                    reason: input.reason,
                    occurredAt: input.occurredAt,
                    reviewedHeadSha: input.headSha,
                    reviewedBaseSha: input.baseSha,
                },
                input.notAfter ? { notAfter: input.notAfter } : undefined,
            );
        } catch (error) {
            // The outbox write is a bookkeeping side effect. The decision is
            // already committed to the per-PR record and projected onto the
            // host; a failed outbox write must not undo it, and must not
            // throw into the reconcile (which would mark the apply partial
            // and re-run the whole host sequence).
            this.logger.warn?.({
                message:
                    '[pr-decision] could not record the approval-reason delivery row',
                context: PrDecisionRecorderService.name,
                metadata: {
                    organizationId: input.organizationId,
                    repositoryId: input.repositoryId,
                    prNumber: input.prNumber,
                    decision: input.decision,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
}
