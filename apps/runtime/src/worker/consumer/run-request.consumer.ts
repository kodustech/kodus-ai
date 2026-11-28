import type { RunDeliveryContext } from '../../shared/admission/pr-admission-store';
import { MessageHandlerErrorBehavior, Nack, RabbitPayload, RabbitRequest, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';

import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from '@libs/core/workflow/infrastructure/workflow-queue-arguments';
import { RUNTIME_CONTROL_BINDING, RUNTIME_CONTROL_QUEUE, RUNTIME_EXCHANGE, RUNTIME_RUN_BINDING, RUNTIME_RUN_QUEUE, RuntimeEventName } from '@libs/runtime/run';

import type { CommandHandler } from '../commands/command-handlers';
import { RUNTIME_COMMAND_HANDLERS } from '../commands/runtime-command-handlers';
import { isRunLaneEvent } from '@libs/runtime/contracts/runtime-commands';
import { RUNTIME_CONTROL_ROUTING_KEY, RUNTIME_RUN_ROUTING_KEY } from '@libs/runtime/run/run-messages';
import { deserializeRuntimeCommand, RuntimeRunRetry, runtimeRunErrorHandler } from './runtime-run-retry';

export type { EgressPolicyPusher } from '../commands/command-handlers';

// Consumes workflow.jobs.runtime_run.queue: an OutboxMessage without a job,
// with the full payload. No WorkflowJobConsumer and no product inbox: the
// DBOS workflowID (= runId) is the idempotency, and the ack only happens after
// the workflow is durably enqueued. This class only routes: each
// event has its own handler (worker/commands).

type Envelope = { event_name?: string; payload?: Record<string, unknown> } & Record<string, unknown>;

function unwrap(input: unknown): { event: string; body: Record<string, unknown> } | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const msg = input as Envelope;
    const event = Object.hasOwn(msg, 'event_name') ? msg.event_name : RuntimeEventName.RunRequested;
    if (typeof event !== 'string') return undefined;
    const body = msg.payload ?? msg;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const { workflowType: _wt, ...rest } = body;
    return { event, body: rest };
}

@Injectable()
export class RuntimeCommandConsumer {
    private readonly logger = new Logger('RuntimeCommandConsumer');
    private readonly handlers: Map<string, CommandHandler>;

    constructor(
        @Inject(RUNTIME_COMMAND_HANDLERS) handlers: readonly CommandHandler[],
        /** Required in the module; a unit test without a broker leaves it out, and a failed dispatch then dead-letters. */
        @Inject(RuntimeRunRetry) private readonly retry?: RuntimeRunRetry,
    ) {
        this.handlers = new Map(handlers.map((h) => [h.event, h]));
    }

    @RabbitSubscribe({
        exchange: RUNTIME_EXCHANGE,
        routingKey: RUNTIME_RUN_BINDING,
        queue: RUNTIME_RUN_QUEUE,
        errorBehavior: MessageHandlerErrorBehavior.NACK,
        errorHandler: runtimeRunErrorHandler,
        deserializer: deserializeRuntimeCommand,
        queueOptions: { channel: 'channel-runtime-run', arguments: WORKFLOW_JOB_QUEUE_ARGUMENTS[RUNTIME_RUN_QUEUE] },
    })
    async onMessage(@RabbitPayload() msg: unknown, @RabbitRequest() raw?: ConsumeMessage) {
        const parsed = unwrap(msg);
        if (!parsed || !isRunLaneEvent(parsed.event)) return this.reject('invalid_run_lane');
        if (raw && raw.fields.routingKey !== RUNTIME_RUN_ROUTING_KEY) return this.reject('invalid_run_route');
        if (this.retry && !this.retry.validCounter(raw)) return this.reject('invalid_retry_counter');
        try { return await this.handle(msg, {
            ...(typeof raw?.properties.messageId === 'string' && raw.properties.messageId.length > 0 && raw.properties.messageId.length <= 256 ? { messageId: raw.properties.messageId } : {}),
            redelivered: raw?.fields.redelivered === true || (typeof raw?.properties.headers?.['x-retry-count'] === 'number' && raw.properties.headers['x-retry-count'] > 0),
        }); }
        catch (error) {
            if ((error as { code?: unknown } | null)?.code === 'admission_conflict') return this.reject('admission_conflict');
            if (this.retry) throw this.retry.failure();
            return this.reject('dispatch_unavailable');
        }
    }

    /** Stop, revoke, approvals and pool: their own queue and channel, never behind Run requests. */
    @RabbitSubscribe({
        exchange: RUNTIME_EXCHANGE,
        routingKey: RUNTIME_CONTROL_BINDING,
        queue: RUNTIME_CONTROL_QUEUE,
        errorBehavior: MessageHandlerErrorBehavior.NACK,
        errorHandler: runtimeRunErrorHandler,
        deserializer: deserializeRuntimeCommand,
        queueOptions: { channel: 'channel-runtime-control', arguments: WORKFLOW_JOB_QUEUE_ARGUMENTS[RUNTIME_CONTROL_QUEUE] },
    })
    async onControl(@RabbitPayload() msg: unknown, @RabbitRequest() raw?: ConsumeMessage) {
        const parsed = unwrap(msg);
        if (!parsed || isRunLaneEvent(parsed.event)) return this.reject('invalid_control_lane');
        if (raw && raw.fields.routingKey !== RUNTIME_CONTROL_ROUTING_KEY) return this.reject('invalid_control_route');
        if (this.retry && !this.retry.validCounter(raw)) return this.reject('invalid_retry_counter');
        // Every control handler is idempotent (keyed or state-guarded writes), so a failure retries with delay.
        // A schema-invalid command returns from handle() as a Nack and never reaches the retry.
        try { return await this.handle(msg); }
        catch {
            if (this.retry) throw this.retry.failure();
            return this.reject('control_dispatch_unavailable');
        }
    }

    async handle(msg: unknown, delivery?: RunDeliveryContext): Promise<void | Nack> {
        const parsed = unwrap(msg);
        if (!parsed) return this.reject('invalid_envelope');
        const { event, body } = parsed;
        const handler = this.handlers.get(event);
        if (!handler) return this.reject('unknown_event');
        const out = await handler.handle(body, delivery);
        if (out && 'invalid' in out) return this.reject('invalid_command');
    }

    private reject(reason: string) {
        this.logger.error({ msg: 'message.dead_lettered', reason });
        return new Nack(false);
    }
}
