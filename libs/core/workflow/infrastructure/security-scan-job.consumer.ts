import { Injectable } from '@nestjs/common';
import {
    MessageHandlerErrorBehavior,
    RabbitSubscribe,
} from '@golevelup/nestjs-rabbitmq';
import { ConsumeMessage } from 'amqplib';

import { MessagePayload } from '@libs/core/domain/contracts/message-broker.service.contracts';
import { createRabbitMQErrorHandlerWithFallback } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';
import { ClaimConflictError } from '@libs/core/workflow/domain/errors/claim-conflict.error';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

import {
    WorkflowJobConsumerBase,
    type WorkflowJobMessage,
} from './workflow-job-consumer.service';
import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from './workflow-queue-arguments';
import {
    isSliceChildNonZeroExit,
    runSecurityScanSliceChild,
} from './security-scan-slice.runner';
import {
    SECURITY_SCAN_CLAIM_HEARTBEAT_MS,
    SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES,
    SECURITY_SCAN_HEARTBEAT_STALE_MS,
} from './security-scan-runtime';

/** The deep scan worker's one queue (#2451), on a worker of its own. */
@Injectable()
export class SecurityScanJobConsumer extends WorkflowJobConsumerBase {
    private readonly sliceAborts = new Set<AbortController>();

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
        for (const abort of this.sliceAborts) {
            abort.abort();
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
            if (abort.signal.aborted) {
                throw new ClaimConflictError(
                    abortReason
                        ? `Security-scan slice aborted: ${abortReason}`
                        : 'Security-scan slice aborted: inbox claim lost or parent shutting down',
                );
            }
            if (isSliceChildNonZeroExit(error)) {
                const job = await this.jobRepository.findOne(jobId);
                if (
                    job?.status === JobStatus.FAILED ||
                    job?.status === JobStatus.COMPLETED ||
                    job?.status === JobStatus.CANCELLED
                ) {
                    throw error;
                }
                throw new Error(
                    `Security-scan slice child left job ${jobId} unrecorded`,
                );
            }
            throw error;
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
        queue: 'workflow.jobs.security_scan.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: 'channel-security-scan',
            arguments:
                WORKFLOW_JOB_QUEUE_ARGUMENTS[
                    'workflow.jobs.security_scan.queue'
                ],
        },
    })
    async handleSecurityScanJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.security_scan',
            'workflow.jobs.security_scan.queue',
            message,
            amqpMsg,
        );
    }
}
