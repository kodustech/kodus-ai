import {
    RUNTIME_CONTROL_QUEUE,
    RUNTIME_CONTROL_ROUTING_KEY,
    RUNTIME_RETRY_DELAY_HEADER,
    RUNTIME_RETRY_DELAYS_MS,
    RUNTIME_RETRY_RETURN_EXCHANGE,
    RUNTIME_RUN_QUEUE,
    RUNTIME_RUN_RETRY_EXCHANGE,
    RUNTIME_RUN_ROUTING_KEY,
    runtimeRetryWaitQueue,
} from '@libs/runtime/run/run-messages';

/** The calls of an amqplib channel this topology makes. */
export interface RuntimeRetryChannel {
    assertExchange(name: string, type: string, options: { durable: boolean }): Promise<unknown>;
    assertQueue(name: string, options: { durable: boolean; arguments: Record<string, unknown> }): Promise<unknown>;
    bindQueue(queue: string, exchange: string, key: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** The lanes the runtime-worker retries: one return edge each, by its routing key. */
export const RUNTIME_RETRY_LANES = [
    { queue: RUNTIME_RUN_QUEUE, routingKey: RUNTIME_RUN_ROUTING_KEY },
    { queue: RUNTIME_CONTROL_QUEUE, routingKey: RUNTIME_CONTROL_ROUTING_KEY },
] as const;

/**
 * A wait queue holds a retry for its TTL, then dead-letters it to the return exchange with the
 * routing key it was published with (no x-dead-letter-routing-key). Quorum, and at-least-once
 * dead-lettering (which needs reject-publish overflow), so a leader change loses no retry.
 */
export function runtimeRetryWaitQueueArguments(delayMs: number): Record<string, unknown> {
    return {
        'x-queue-type': 'quorum',
        'x-message-ttl': delayMs,
        'x-dead-letter-exchange': RUNTIME_RETRY_RETURN_EXCHANGE,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
    };
}

/**
 * The retry exchanges and wait queues (run-messages.ts RUNTIME_RUN_RETRY_EXCHANGE). The Runtime
 * queues themselves are asserted by the caller, which binds them with bindRuntimeRetryLane.
 */
export async function declareRuntimeRetry(channel: RuntimeRetryChannel): Promise<void> {
    await channel.assertExchange(RUNTIME_RUN_RETRY_EXCHANGE, 'headers', { durable: true });
    await channel.assertExchange(RUNTIME_RETRY_RETURN_EXCHANGE, 'direct', { durable: true });
    for (const delayMs of RUNTIME_RETRY_DELAYS_MS) {
        const queue = runtimeRetryWaitQueue(delayMs);
        await channel.assertQueue(queue, { durable: true, arguments: runtimeRetryWaitQueueArguments(delayMs) });
        await channel.bindQueue(queue, RUNTIME_RUN_RETRY_EXCHANGE, '', {
            'x-match': 'all',
            [RUNTIME_RETRY_DELAY_HEADER]: String(delayMs),
        });
    }
}

/** A Runtime queue's edge from the return exchange; nothing else is bound there. */
export async function bindRuntimeRetryLane(channel: RuntimeRetryChannel, queue: string): Promise<void> {
    const lane = RUNTIME_RETRY_LANES.find((l) => l.queue === queue);
    if (lane) await channel.bindQueue(lane.queue, RUNTIME_RETRY_RETURN_EXCHANGE, lane.routingKey);
}
