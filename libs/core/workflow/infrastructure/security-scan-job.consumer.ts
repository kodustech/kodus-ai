import { Injectable } from '@nestjs/common';
import {
    MessageHandlerErrorBehavior,
    RabbitSubscribe,
} from '@golevelup/nestjs-rabbitmq';
import { ConsumeMessage } from 'amqplib';

import { MessagePayload } from '@libs/core/domain/contracts/message-broker.service.contracts';
import { createRabbitMQErrorHandlerWithFallback } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';
import { ClaimConflictError } from '@libs/core/workflow/domain/errors/claim-conflict.error';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

import {
    WorkflowJobConsumerBase,
    type WorkflowJobMessage,
} from './workflow-job-consumer.service';
import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from './workflow-queue-arguments';
import {
    isSliceChildNonZeroExit,
    isSliceChildPreemptedExit,
    runSecurityScanSliceChild,
} from './security-scan-slice.runner';
import {
    SECURITY_SCAN_CLAIM_HEARTBEAT_MS,
    SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES,
    SECURITY_SCAN_HEARTBEAT_STALE_MS,
    SECURITY_SCAN_JOB_QUEUE,
} from './security-scan-runtime';
import { INBOX_RELEASE_TIMEOUT_MS } from './drain-timeout';
import { runWithBoundedTimeout } from './run-with-bounded-timeout';

/** The deep scan worker's one queue (#2451), on a worker of its own. */
@Injectable()
export class SecurityScanJobConsumer extends WorkflowJobConsumerBase {
    private readonly sliceAborts = new Set<AbortController>();
    /** Shutdown aborted the slices; its consumers are already cancelled. */
    private draining = false;

    protected resolveClaimTimeoutMinutes(): number {
        return SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES;
    }

    protected heldClaimError(): Error {
        return new ClaimConflictError();
    }

    protected shouldMarkJobFailed(error: unknown): boolean {
        if (!super.shouldMarkJobFailed(error)) {
            return false;
        }
        return !isSliceChildNonZeroExit(error);
    }

    protected abortInFlightWork(): void {
        this.draining = true;
        for (const abort of this.sliceAborts) {
            abort.abort();
        }
    }

    /**
     * A slice this worker's shutdown stopped goes back to its queue as a
     * fresh copy, not through the delayed exchange: the scan stays RUNNING
     * and only this message can continue it, and no consumer here takes it
     * back. One stopped while the consumer still runs (lost claim, stale
     * heartbeat, child preempted on its own) waits the held-claim delay,
     * so this parent does not fork a second child straight away.
     */
    private sliceAbortedError(abortReason?: string): ClaimConflictError {
        return new ClaimConflictError(
            abortReason
                ? `Security-scan slice aborted: ${abortReason}`
                : 'Security-scan slice aborted: inbox claim lost or parent shutting down',
            undefined,
            { returnToQueue: this.draining },
        );
    }

    private async handleSliceChildFailure(params: {
        jobId: string;
        error: unknown;
        abort: AbortController;
        abortReason?: string;
        messageId: string;
        consumerId: string;
    }): Promise<void> {
        const { jobId, error, abort, abortReason, messageId, consumerId } =
            params;
        if (abort.signal.aborted) {
            throw this.sliceAbortedError(abortReason);
        }
        if (!isSliceChildNonZeroExit(error)) {
            throw error;
        }

        let job: { status?: string } | undefined;
        try {
            job = await runWithBoundedTimeout(
                this.jobRepository.findOne(jobId),
                INBOX_RELEASE_TIMEOUT_MS,
                'security-scan.job.findOne',
            );
        } catch (lookupError) {
            this.logger.error({
                message:
                    'Security-scan job lookup failed after slice child exit',
                context: 'SecurityScanJobConsumer',
                error: lookupError,
                metadata: { jobId, messageId, consumerId },
            });
        }

        if (abort.signal.aborted) {
            throw this.sliceAbortedError(abortReason);
        }
        if (job?.status === JobStatus.COMPLETED) {
            return;
        }
        if (
            job?.status === JobStatus.FAILED ||
            job?.status === JobStatus.CANCELLED
        ) {
            throw error;
        }
        if (isSliceChildPreemptedExit(error)) {
            throw this.sliceAbortedError(abortReason ?? 'child preempted');
        }
        await this.failJobIfStillProcessing(jobId, error);
        throw error;
    }

    private async failJobIfStillProcessing(
        jobId: string,
        error: unknown,
    ): Promise<void> {
        const lastError =
            error instanceof Error ? error.message : String(error);
        try {
            await runWithBoundedTimeout(
                this.jobRepository.failIfProcessing(jobId, {
                    lastError,
                    errorClassification: ErrorClassification.PERMANENT,
                }),
                INBOX_RELEASE_TIMEOUT_MS,
                'security-scan.job.failIfProcessing',
            );
        } catch (writeError) {
            this.logger.error({
                message:
                    'Security-scan failed to mark PROCESSING job FAILED after child exit',
                context: 'SecurityScanJobConsumer',
                error: writeError,
                metadata: { jobId },
            });
        }
    }

    /**
     * Deep-scan slices run in a child process so CPU stalls cannot block
     * the parent's AMQP heartbeats or the ECS health probe. The parent
     * heartbeats the inbox claim while it waits; a dead parent is
     * stealable after SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES.
     */
    protected async executeJob(
        jobId: string,
        _queueName: string,
        messageId: string,
        consumerId: string,
    ): Promise<void> {
        const abort = new AbortController();
        this.sliceAborts.add(abort);
        let lastHeldAt = Date.now();
        let beating = false;
        let abortReason: string | undefined;
        const beat = setInterval(() => {
            if (Date.now() - lastHeldAt >= SECURITY_SCAN_HEARTBEAT_STALE_MS) {
                abortReason = 'inbox heartbeat stale';
                abort.abort();
                return;
            }
            if (beating) return;
            beating = true;
            void this.inboxRepository
                .heartbeat(messageId, consumerId, this.instanceId)
                .then((held) => {
                    if (!held) {
                        abortReason = 'inbox claim lost';
                        abort.abort();
                        return;
                    }
                    lastHeldAt = Date.now();
                })
                .catch((error) => {
                    this.logger.error({
                        message: 'Security-scan inbox heartbeat failed',
                        context: 'SecurityScanJobConsumer',
                        error,
                        metadata: { messageId, jobId, consumerId },
                    });
                    if (
                        Date.now() - lastHeldAt >=
                        SECURITY_SCAN_HEARTBEAT_STALE_MS
                    ) {
                        abortReason = 'inbox heartbeat stale';
                        abort.abort();
                    }
                })
                .finally(() => {
                    beating = false;
                });
        }, SECURITY_SCAN_CLAIM_HEARTBEAT_MS);
        beat.unref();

        try {
            await runSecurityScanSliceChild(jobId, {
                abortSignal: abort.signal,
            });
        } catch (error) {
            await this.handleSliceChildFailure({
                jobId,
                error,
                abort,
                abortReason,
                messageId,
                consumerId,
            });
        } finally {
            clearInterval(beat);
            this.sliceAborts.delete(abort);
        }
    }

    /**
     * Security scan slices (#2451). One slice per sandbox lifetime; a scan
     * that needs more re-enqueues itself. The parent only claims and waits;
     * the engine runs in a child so AMQP and ECS health stay on a free
     * event loop. Prefetch defaults to 1: each slice forks a Nest heap.
     */
    @RabbitSubscribe({
        name: 'security-scan',
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.SECURITY_SCAN',
        queue: SECURITY_SCAN_JOB_QUEUE,
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: 'channel-security-scan',
            arguments: WORKFLOW_JOB_QUEUE_ARGUMENTS[SECURITY_SCAN_JOB_QUEUE],
        },
    })
    async handleSecurityScanJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.security_scan',
            SECURITY_SCAN_JOB_QUEUE,
            message,
            amqpMsg,
        );
    }
}
