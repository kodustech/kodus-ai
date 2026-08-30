import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@libs/core/domain/contracts/message-broker.service.contracts';
import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { IWorkflowJob } from '@libs/core/workflow/domain/interfaces/workflow-job.interface';

export type PrReviewDeferral = {
    delayMs: number;
    deferredCount: number;
};

/**
 * Reschedules a user-issued code review that collided with a run already
 * holding the PR, so the request waits for its turn instead of being
 * dropped (#1700).
 *
 * Same outbox mechanism as the BYOK concurrency gate: the job goes back to
 * PENDING with a future `nextAttemptAt` and the existing relay re-publishes
 * it, so no delayed-exchange plugin is involved.
 */
@Injectable()
export class PrReviewDeferralService {
    private readonly logger = createLogger(PrReviewDeferralService.name);

    private static readonly BASE_DELAY_MS = 15_000;

    /**
     * Capped low on purpose. The holder releases at a moment we cannot
     * predict, and retrying costs almost nothing, so a long sleep just
     * adds dead time — a 5-minute cap left a queued command waiting ~2.5
     * minutes after the review it was waiting for had already finished.
     */
    private static readonly MAX_DELAY_MS = 60_000;

    /**
     * Upper bound on attempts (~24.75 min of waiting). The real stop
     * condition is `holderVisibleUntil` below — this only caps a case
     * where no deadline is known.
     */
    private static readonly MAX_DEFERRALS = 26;

    private static readonly METADATA_KEY = 'prReviewDeferral';

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outboxRepository: IOutboxMessageRepository,
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,
    ) {}

    /**
     * The next deferral for this job, or null once the caller should give
     * up and say so on the PR.
     *
     * `holderVisibleUntil` is the moment the run holding the PR stops
     * being visible to the gate that refused us. It is measured from the
     * HOLDER's start, not from the collision, so it cannot be expressed as
     * a fixed number of attempts: a command colliding 20 minutes into a
     * long review has far less budget than one colliding immediately.
     * Retrying past it would clear both gates while the holder is still
     * running and start a second concurrent review.
     */
    next(
        job: IWorkflowJob,
        holderVisibleUntil?: Date,
    ): PrReviewDeferral | null {
        const deferredCount = this.getDeferredCount(job) + 1;

        if (deferredCount > PrReviewDeferralService.MAX_DEFERRALS) {
            return null;
        }

        const delayMs = Math.min(
            PrReviewDeferralService.BASE_DELAY_MS *
                2 ** Math.max(0, deferredCount - 1),
            PrReviewDeferralService.MAX_DELAY_MS,
        );

        if (
            holderVisibleUntil &&
            Date.now() + delayMs >= holderVisibleUntil.getTime()
        ) {
            return null;
        }

        return { deferredCount, delayMs };
    }

    async defer(
        job: IWorkflowJob,
        deferral: PrReviewDeferral,
    ): Promise<void> {
        const nextAttemptAt = new Date(Date.now() + deferral.delayMs);

        await this.jobRepository.update(job.id, {
            status: JobStatus.PENDING,
            scheduledAt: nextAttemptAt,
            lastError:
                'Waiting for the review already running on this PR to finish',
            metadata: {
                ...(job.metadata || {}),
                [PrReviewDeferralService.METADATA_KEY]: {
                    deferredCount: deferral.deferredCount,
                    delayMs: deferral.delayMs,
                    deferredAt: new Date().toISOString(),
                    nextAttemptAt: nextAttemptAt.toISOString(),
                },
            },
        });

        await this.outboxRepository.create({
            jobId: job.id,
            exchange: 'workflow.exchange',
            routingKey: `workflow.jobs.deferred.${job.workflowType}`,
            payload: this.messageBroker.transformMessageToMessageBroker({
                eventName: 'workflow.jobs.deferred',
                message: {
                    jobId: job.id,
                    correlationId: job.correlationId,
                    workflowType: job.workflowType,
                    handlerType: job.handlerType,
                    organizationId: job.organizationAndTeamData?.organizationId,
                    teamId: job.organizationAndTeamData?.teamId,
                },
            }) as unknown as Record<string, unknown>,
            nextAttemptAt,
        });

        this.logger.warn({
            message: `Deferred code review command for job ${job.id} — PR is busy`,
            context: PrReviewDeferralService.name,
            metadata: {
                jobId: job.id,
                correlationId: job.correlationId,
                deferredCount: deferral.deferredCount,
                delayMs: deferral.delayMs,
                nextAttemptAt: nextAttemptAt.toISOString(),
            },
        });
    }

    private getDeferredCount(job: IWorkflowJob): number {
        const state = (job.metadata as Record<string, unknown> | null)?.[
            PrReviewDeferralService.METADATA_KEY
        ] as { deferredCount?: unknown } | undefined;

        return typeof state?.deferredCount === 'number'
            ? state.deferredCount
            : 0;
    }
}
