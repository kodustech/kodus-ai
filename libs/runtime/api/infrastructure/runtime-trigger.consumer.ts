import { MessageHandlerErrorBehavior, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';

import { createRabbitMQErrorHandlerWithFallback } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';
import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from '@libs/core/workflow/infrastructure/workflow-queue-arguments';
import { RUNTIME_EXCHANGE, RUNTIME_TRIGGER_BINDING, RUNTIME_TRIGGER_QUEUE } from '@libs/runtime/run';

import { RuntimePullRequestTriggerUseCase } from '../application/use-cases/pull-request-trigger.use-case';

export const RUNTIME_TRIGGER_CHANNEL = 'channel-runtime-trigger';

/**
 * Pull request events for the Runtime trigger (PR 2), written to the outbox by
 * the webhook handler. Not a workflow job: the trigger is idempotent by itself
 * (a live or finished Run on the same head is never started twice). A failure
 * throws and the shared error handler retries it through
 * workflow.exchange.delayed, then dead-letters it.
 */
@Injectable()
export class RuntimeTriggerConsumer {
    constructor(private readonly trigger: RuntimePullRequestTriggerUseCase) {}

    @RabbitSubscribe({
        exchange: RUNTIME_EXCHANGE,
        routingKey: RUNTIME_TRIGGER_BINDING,
        queue: RUNTIME_TRIGGER_QUEUE,
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback('workflow.job.failed'),
        queueOptions: {
            channel: RUNTIME_TRIGGER_CHANNEL,
            arguments: WORKFLOW_JOB_QUEUE_ARGUMENTS[RUNTIME_TRIGGER_QUEUE],
        },
    })
    async handle(message: unknown): Promise<void> {
        await this.trigger.execute(message);
    }
}
