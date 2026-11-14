import {
    MessageHandlerErrorBehavior,
    RabbitSubscribe,
} from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';

import { createRabbitMQErrorHandlerWithFallback } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';
import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from '@libs/core/workflow/infrastructure/workflow-queue-arguments';
import {
    RUNTIME_EXCHANGE,
    RUNTIME_PUBLISH_BINDING,
    RUNTIME_PUBLISH_QUEUE,
} from '@libs/runtime/run';

import { PublishRuntimeRequestUseCase } from '../application/publish-runtime-request.use-case';

export const RUNTIME_PUBLISH_CHANNEL = 'channel-runtime-publish';

/**
 * RuntimePublishRequested from the Runtime (docs §7, ADR-052). Not a workflow
 * job: no job row and no product inbox; idempotency is the publication key
 * and, for the PR comment, the PR's comment slot. A refusal returns (ack); a
 * failed publish throws and the shared error handler retries it through
 * workflow.exchange.delayed, then dead-letters it.
 */
@Injectable()
export class RuntimePublishRequestedConsumer {
    constructor(private readonly publish: PublishRuntimeRequestUseCase) {}

    @RabbitSubscribe({
        exchange: RUNTIME_EXCHANGE,
        routingKey: RUNTIME_PUBLISH_BINDING,
        queue: RUNTIME_PUBLISH_QUEUE,
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: RUNTIME_PUBLISH_CHANNEL,
            arguments: WORKFLOW_JOB_QUEUE_ARGUMENTS[RUNTIME_PUBLISH_QUEUE],
        },
    })
    async handle(message: unknown): Promise<void> {
        await this.publish.execute(message);
    }
}
