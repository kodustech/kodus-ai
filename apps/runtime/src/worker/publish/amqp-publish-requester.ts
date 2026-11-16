import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

import {
    RUNTIME_EXCHANGE,
    RUNTIME_PUBLISH_ROUTING_KEY,
    RuntimeEventName,
    runtimeEnvelope,
    RuntimePublishRequested,
    RuntimePublishRequestedSchema,
} from '@libs/runtime/run';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import type { PublishRequester } from '../run/ports';

/** How long the broker has to confirm a publication before the step fails (and is retried). */
export const PUBLISH_CONFIRM_TIMEOUT_MS = 10_000;

/**
 * Writes RuntimePublishRequested; the product worker publishes it (ADR-052).
 * The managed channel is a confirm channel (amqp-connection-manager): the
 * returned promise resolves on the broker's ack, so the DBOS step that calls
 * this is checkpointed only once the broker holds the message. No confirm in
 * PUBLISH_CONFIRM_TIMEOUT_MS fails the step instead of hanging it.
 */
export class AmqpPublishRequester implements PublishRequester {
    constructor(private readonly amqp: Pick<AmqpConnection, 'publish'>) {}

    async request(msg: RuntimePublishRequested): Promise<void> {
        const payload = RuntimePublishRequestedSchema.parse(msg);
        const envelope = runtimeEnvelope(RuntimeEventName.PublishRequested, { ...payload, workflowType: WorkflowType.RUNTIME_PUBLISH }, payload.key);
        const options = {
            messageId: payload.key,
            correlationId: payload.correlationId,
            persistent: true,
            headers: { 'x-correlation-id': payload.correlationId, 'x-workflow-type': WorkflowType.RUNTIME_PUBLISH },
            // amqp-connection-manager's per-publish confirm deadline.
            timeout: PUBLISH_CONFIRM_TIMEOUT_MS,
        };
        // The publish promise resolves only on the broker's ack and rejects on a nack or the timeout; the
        // resolved boolean is only whether the write buffer had room (backpressure), never a refusal.
        // Installed sources: @golevelup/nestjs-rabbitmq 9.0.2 lib/amqp/connection.js:610 (ChannelWrapper.publish),
        // :670 (no `confirm`, so a confirm channel); amqp-connection-manager 5.0.0 dist/cjs/ChannelWrapper.js:266,
        // :461-476 (resolve with channel.publish's result on ack, reject on error), :199-212 (timeout);
        // amqplib 2.0.1 lib/connection.js:501 (publish returns the buffer's write()), lib/channel.js:33 (nack).
        await this.amqp.publish(RUNTIME_EXCHANGE, RUNTIME_PUBLISH_ROUTING_KEY, envelope, options as Parameters<AmqpConnection['publish']>[3]);
    }
}
