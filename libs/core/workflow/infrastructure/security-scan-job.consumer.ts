import { Injectable } from '@nestjs/common';
import {
    MessageHandlerErrorBehavior,
    RabbitSubscribe,
} from '@golevelup/nestjs-rabbitmq';
import { ConsumeMessage } from 'amqplib';

import { MessagePayload } from '@libs/core/domain/contracts/message-broker.service.contracts';
import { createRabbitMQErrorHandlerWithFallback } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';

import {
    WorkflowJobConsumerBase,
    type WorkflowJobMessage,
} from './workflow-job-consumer.service';
import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from './workflow-queue-arguments';

/** The deep scan worker's one queue (#2451), on a worker of its own. */
@Injectable()
export class SecurityScanJobConsumer extends WorkflowJobConsumerBase {
    /**
     * Security scan slices (#2451). One slice per sandbox lifetime; a scan
     * that needs more re-enqueues itself. Prefetch is low: every slice holds
     * a sandbox and runs model calls for up to half an hour.
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
