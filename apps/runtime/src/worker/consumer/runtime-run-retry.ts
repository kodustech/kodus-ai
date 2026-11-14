import type {
    AmqpConnection,
    MessageErrorHandler,
} from '@golevelup/nestjs-rabbitmq';
import { Logger } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';

import {
    RUNTIME_RUN_RETRY_EXCHANGE,
    RUNTIME_RUN_ROUTING_KEY,
} from '@libs/runtime/run/run-messages';

export interface RuntimeRetryPolicy {
    maxRetries: number;
    delayMs: number;
    maxDelayMs: number;
}

const INVALID_MESSAGE = Symbol('invalid Runtime JSON');

/** Return poison to the consumer: the broker library otherwise logs parser input in its stack. */
export function deserializeRuntimeCommand(bytes: Buffer): unknown {
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch {
        return INVALID_MESSAGE;
    }
}

type RecoverDelivery = (
    channel: Channel,
    message: ConsumeMessage,
) => Promise<void>;

/** The library logs only this closed stack; no cause or enumerable service/credential is attached. */
class RuntimeRunDispatchFailure extends Error {
    readonly #recover: RecoverDelivery;
    constructor(recover: RecoverDelivery) {
        super('runtime_run_dispatch_unavailable');
        this.name = 'RuntimeRunDispatchFailure';
        this.#recover = recover;
    }
    recover(channel: Channel, message: ConsumeMessage) {
        return this.#recover(channel, message);
    }
}

/** Per-delivery recovery carries its own DI instance: no cross-module/global singleton. */
export const runtimeRunErrorHandler: MessageErrorHandler = async (
    channel,
    message,
    error: unknown,
) => {
    if (error instanceof RuntimeRunDispatchFailure)
        await error.recover(channel, message);
    else channel.nack(message, false, false);
};

/** Run/setup requests may retry before durable admission, never the execution's individual steps. */
export class RuntimeRunRetry {
    private readonly logger = new Logger(RuntimeRunRetry.name);
    constructor(
        private readonly amqp: Pick<AmqpConnection, 'publish'>,
        private readonly policy: RuntimeRetryPolicy,
    ) {}

    validCounter(message?: ConsumeMessage): boolean {
        return this.retryCount(message) !== undefined;
    }

    failure(): Error {
        return new RuntimeRunDispatchFailure((channel, message) =>
            this.recover(channel, message),
        );
    }

    private retryCount(message?: ConsumeMessage): number | undefined {
        const count = message?.properties.headers?.['x-retry-count'];
        if (count === undefined) return 0;
        return typeof count === 'number' &&
            Number.isSafeInteger(count) &&
            count >= 0 &&
            count <= this.policy.maxRetries
            ? count
            : undefined;
    }

    private async recover(
        channel: Channel,
        message: ConsumeMessage,
    ): Promise<void> {
        const count = this.retryCount(message);
        if (
            count === undefined ||
            count >= this.policy.maxRetries ||
            message.fields.routingKey !== RUNTIME_RUN_ROUTING_KEY
        ) {
            this.logger.warn({
                msg: 'runtime.command.retry',
                outcome: count === undefined ? 'invalid_counter' : 'exhausted',
                attempt: count,
            });
            channel.nack(message, false, false);
            return;
        }
        const headers = { ...message.properties.headers };
        // Old product retries may carry raw diagnostics. They are never propagated by this boundary.
        delete headers['x-last-error'];
        delete headers['x-last-error-message'];
        headers['x-retry-count'] = count + 1;
        const delayMs = Math.min(
            this.policy.maxDelayMs,
            this.policy.delayMs * 2 ** count,
        );
        // amqplib auto-encodes small numbers as signed byte, which x-delayed
        // does not accept. Force a supported int32 even for sub-128ms retries.
        headers['x-delay'] = { '!': 'int', 'value': delayMs };
        try {
            // AmqpConnection uses a confirm channel. Both resolved booleans mean broker ACK;
            // false indicates backpressure. Only rejection means publish failed.
            // ChannelWrapper's supported timeout removes queued/unconfirmed messages on
            // expiry; Promise.race alone would leave a disconnected publisher accumulating work.
            const options = {
                ...message.properties,
                headers,
                persistent: true,
                deliveryMode: 2,
                timeout: 5000,
            };
            await this.amqp.publish(
                RUNTIME_RUN_RETRY_EXCHANGE,
                message.fields.routingKey,
                message.content,
                options,
            );
            channel.ack(message);
            this.logger.warn({
                msg: 'runtime.command.retry',
                outcome: 'scheduled',
                attempt: count + 1,
                delayMs,
            });
        } catch {
            // Leave the original unacked so channel/process recovery can redeliver it.
            this.logger.error({
                msg: 'runtime.command.retry',
                outcome: 'publish_failed',
                attempt: count + 1,
            });
            throw new Error('runtime_run_retry_publish_failed');
        }
    }
}
