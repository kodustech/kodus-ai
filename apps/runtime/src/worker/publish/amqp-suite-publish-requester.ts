import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

import { RUNTIME_EXCHANGE, RuntimeSuitePublishRequestedSchema, suitePublishEnvelope, type RuntimeSuitePublishRequested } from '@libs/runtime/run';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import type { SuitePublishRequester } from '../suite/suite-publisher';
import { PUBLISH_CONFIRM_TIMEOUT_MS } from './amqp-publish-requester';

/**
 * Writes the suite's publication (docs/runtime/e2e-suites.md section 10.1) on the Runtime's publish route, under its own event
 * name; the product worker publishes the check. Like `AmqpPublishRequester`: validated first, the publication key is the
 * message id, and the returned promise resolves only on the broker's confirm, so the DBOS publish step that calls it is
 * checkpointed once the broker holds the message.
 */
export class AmqpSuitePublishRequester implements SuitePublishRequester {
    constructor(private readonly amqp: Pick<AmqpConnection, 'publish'>) {}

    async request(msg: RuntimeSuitePublishRequested): Promise<void> {
        const payload = RuntimeSuitePublishRequestedSchema.parse(msg);
        const { routingKey, envelope } = suitePublishEnvelope(payload);
        const options = {
            messageId: payload.key,
            correlationId: payload.correlationId,
            persistent: true,
            headers: { 'x-correlation-id': payload.correlationId, 'x-workflow-type': WorkflowType.RUNTIME_PUBLISH },
            timeout: PUBLISH_CONFIRM_TIMEOUT_MS,
        };
        await this.amqp.publish(RUNTIME_EXCHANGE, routingKey, envelope, options as Parameters<AmqpConnection['publish']>[3]);
    }
}
