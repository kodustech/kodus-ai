import type { Channel } from 'amqplib';

import { RABBITMQ_TOPOLOGY_CONFIG } from './rabbitmq-topology.config';

/**
 * Delayed retries without the `rabbitmq_delayed_message_exchange` plugin.
 *
 * The plugin is unmaintained and cannot run on RabbitMQ >= 4.3 (#1663). It
 * also held every delayed message on a single node, unreplicated. Retries now
 * wait in quorum queues with a fixed TTL and dead-letter back when it expires:
 *
 *   consumer fails
 *     -> publish to RETRY_EXCHANGE (headers), original routing key,
 *        headers { kodus-retry-bucket, kodus-retry-target }
 *     -> wait queue for that bucket (quorum, x-message-ttl = bucket)
 *     -> TTL expires, dead-letters to RETURN_EXCHANGE (headers)
 *     -> exchange-to-exchange binding matching kodus-retry-target
 *     -> the base exchange, which routes by the original routing key.
 *
 * The bucket travels in a header, not in the routing key: a dead-lettered
 * message keeps the routing key it was published with, and that key has to be
 * the original one for the base exchange to route it.
 *
 * A queue only expires messages at its head, so one queue cannot hold
 * different delays: a one-hour retry would hold back a five-second one behind
 * it. Each bucket is its own queue, and a delay is rounded up to the next
 * bucket.
 */

export const RETRY_EXCHANGE = 'kodus.retry';
export const RETRY_RETURN_EXCHANGE = 'kodus.retry.return';

// Not `x-` prefixed on purpose: a headers exchange ignores `x-` headers when
// matching, so a binding on `x-retry-bucket` matches every message and each
// retry would land in every wait queue (and return to every base exchange).
export const RETRY_TARGET_HEADER = 'kodus-retry-target';
export const RETRY_BUCKET_HEADER = 'kodus-retry-bucket';

/**
 * Exchanges a retry can return to. A base exchange missing here has no way
 * back from the wait queues, so the error handler sends its failures to the
 * DLQ.
 */
export const RETRY_TARGET_EXCHANGES = [
    'workflow.exchange',
    'workflow.events',
    'orchestrator.exchange',
] as const;

export type RetryTargetExchange = (typeof RETRY_TARGET_EXCHANGES)[number];

export function isRetryTarget(
    exchange: unknown,
): exchange is RetryTargetExchange {
    return RETRY_TARGET_EXCHANGES.includes(exchange as RetryTargetExchange);
}

/** The type each exchange is declared with in the app topology; one source of truth. */
const DECLARED_EXCHANGE_TYPES = new Map<string, string>(
    RABBITMQ_TOPOLOGY_CONFIG.exchanges.map((e) => [e.name, e.type]),
);

function declaredType(exchange: RetryTargetExchange): string {
    const type = DECLARED_EXCHANGE_TYPES.get(exchange);
    if (!type) {
        throw new Error(
            `Retry target ${exchange} is not declared in RABBITMQ_TOPOLOGY_CONFIG`,
        );
    }
    return type;
}

/**
 * Transient errors back off from WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS to 30s;
 * a GitHub rate limit waits for the bucket reset plus 5 minutes, capped at
 * 1 hour (rabbitmq-error.handler.ts). Rounding up costs at most one step.
 */
export const RETRY_BUCKETS_MS = [
    1_000,
    2_000,
    5_000,
    10_000,
    20_000,
    30_000,
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
    20 * 60_000,
    30 * 60_000,
    45 * 60_000,
    60 * 60_000,
] as const;

export function retryWaitQueueName(bucketMs: number): string {
    return `${RETRY_EXCHANGE}.wait.${bucketMs}`;
}

/** The smallest bucket that waits at least `delayMs`; the largest beyond it. */
export function pickRetryBucket(delayMs: number): number {
    for (const bucket of RETRY_BUCKETS_MS) {
        if (delayMs <= bucket) {
            return bucket;
        }
    }
    return RETRY_BUCKETS_MS[RETRY_BUCKETS_MS.length - 1];
}

/**
 * At-least-once dead-lettering keeps a message in the wait queue until the
 * return exchange accepts it, instead of dropping it on the way back; it
 * requires `reject-publish` overflow.
 */
export function retryWaitQueueArguments(
    bucketMs: number,
): Record<string, unknown> {
    return {
        'x-queue-type': 'quorum',
        'x-message-ttl': bucketMs,
        'x-dead-letter-exchange': RETRY_RETURN_EXCHANGE,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
    };
}

/**
 * Declares the retry path. Idempotent, and uses only core RabbitMQ features,
 * so it runs unchanged on a stock broker of any 4.x version.
 */
export async function declareRetryTopology(
    channel: Pick<
        Channel,
        'assertExchange' | 'assertQueue' | 'bindQueue' | 'bindExchange'
    >,
): Promise<void> {
    await channel.assertExchange(RETRY_EXCHANGE, 'headers', { durable: true });
    await channel.assertExchange(RETRY_RETURN_EXCHANGE, 'headers', {
        durable: true,
    });

    for (const bucket of RETRY_BUCKETS_MS) {
        const queue = retryWaitQueueName(bucket);
        await channel.assertQueue(queue, {
            durable: true,
            arguments: retryWaitQueueArguments(bucket),
        });
        await channel.bindQueue(queue, RETRY_EXCHANGE, '', {
            'x-match': 'all',
            [RETRY_BUCKET_HEADER]: String(bucket),
        });
    }

    // Asserted again here, with the same type, because binding to a missing
    // exchange is a 404 that closes the channel -- and a failed setup leaves
    // the consumers registered after it silently absent.
    for (const target of RETRY_TARGET_EXCHANGES) {
        await channel.assertExchange(target, declaredType(target), {
            durable: true,
        });
        await channel.bindExchange(target, RETRY_RETURN_EXCHANGE, '', {
            'x-match': 'all',
            [RETRY_TARGET_HEADER]: target,
        });
    }
}
