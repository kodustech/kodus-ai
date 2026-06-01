import {
    createRabbitMQErrorHandlerWithFallback,
    RabbitMQErrorHandler,
} from './rabbitmq-error.handler';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('RabbitMQErrorHandler', () => {
    const makeHandler = (overrides?: {
        maxRetries?: number;
        retryDelayMs?: number;
        publish?: jest.Mock;
    }) => {
        const amqpConnection = {
            publish:
                overrides?.publish ?? jest.fn().mockResolvedValue(undefined),
        };
        const configService = {
            get: jest.fn((key: string) => {
                if (key === 'workflowQueue.WORKFLOW_QUEUE_WORKER_MAX_RETRIES') {
                    return overrides?.maxRetries ?? 5;
                }
                if (
                    key === 'workflowQueue.WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS'
                ) {
                    return overrides?.retryDelayMs ?? 1000;
                }
                return undefined;
            }),
        };

        return {
            handler: new RabbitMQErrorHandler(
                amqpConnection as any,
                configService as any,
            ),
            amqpConnection,
        };
    };

    const makeMessage = (headers: Record<string, unknown> = {}) =>
        ({
            properties: {
                messageId: 'message-1',
                correlationId: 'correlation-1',
                contentType: 'application/json',
                contentEncoding: 'utf8',
                headers,
            },
            fields: {
                exchange: 'workflow.exchange',
                routingKey: 'workflow.jobs.created.CODE_REVIEW',
            },
            content: Buffer.from('{"jobId":"job-1"}'),
        }) as any;

    it('acks the original message after publishing a delayed retry', async () => {
        const { handler, amqpConnection } = makeHandler();
        const channel = { ack: jest.fn() };
        const msg = makeMessage();

        await handler.handle(channel, msg, new Error('processor failed'), {
            dlqRoutingKey: 'workflow.job.failed',
        });

        expect(amqpConnection.publish).toHaveBeenCalledWith(
            'workflow.exchange.delayed',
            'workflow.jobs.created.CODE_REVIEW',
            msg.content,
            expect.objectContaining({
                messageId: 'message-1',
                correlationId: 'correlation-1',
                persistent: true,
                headers: expect.objectContaining({
                    'x-retry-count': 1,
                    'x-delay': expect.any(Number),
                }),
            }),
        );
        expect(channel.ack).toHaveBeenCalledWith(msg);
        expect(amqpConnection.publish.mock.invocationCallOrder[0]).toBeLessThan(
            channel.ack.mock.invocationCallOrder[0],
        );
    });

    it('acks the original message after publishing to DLQ', async () => {
        const { handler, amqpConnection } = makeHandler({ maxRetries: 5 });
        const channel = { ack: jest.fn() };
        const msg = makeMessage({ 'x-retry-count': 5 });

        await handler.handle(channel, msg, new Error('processor failed'), {
            dlqRoutingKey: 'workflow.job.failed',
        });

        expect(amqpConnection.publish).toHaveBeenCalledWith(
            'workflow.exchange.dlx',
            'workflow.job.failed',
            msg.content,
            expect.objectContaining({
                messageId: 'message-1',
                persistent: true,
                headers: expect.objectContaining({
                    'x-retry-count': 5,
                    'x-original-routing-key':
                        'workflow.jobs.created.CODE_REVIEW',
                    'x-original-exchange': 'workflow.exchange',
                    'x-death-reason': 'max-retries-exceeded',
                    'x-last-error': 'processor failed',
                }),
            }),
        );
        expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it('does not ack the original message when retry publish fails', async () => {
        const publishError = new Error('broker unavailable');
        const { handler } = makeHandler({
            publish: jest.fn().mockRejectedValue(publishError),
        });
        const channel = { ack: jest.fn() };
        const msg = makeMessage();

        await expect(
            handler.handle(channel, msg, new Error('processor failed'), {
                dlqRoutingKey: 'workflow.job.failed',
            }),
        ).rejects.toThrow('may be lost');

        expect(channel.ack).not.toHaveBeenCalled();
    });

    // Covers H8-H11 — RATE_LIMITED delay handling.
    describe('RATE_LIMITED-aware delay', () => {
        it('uses resetAt-based delay (with 5min buffer) instead of exponential backoff', async () => {
            const { handler, amqpConnection } = makeHandler();
            const channel = { ack: jest.fn() };
            const msg = makeMessage();
            const resetAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min ahead

            await handler.handle(
                channel,
                msg,
                new RateLimitError({ resetAt, remaining: 0 }),
                { dlqRoutingKey: 'workflow.job.failed' },
            );

            const published = amqpConnection.publish.mock.calls[0];
            const headers = (published[3] as any).headers;
            // 30min + 5min buffer = 35min ≈ 2_100_000ms. Allow ±10s drift.
            expect(headers['x-delay']).toBeGreaterThan(34 * 60 * 1000);
            expect(headers['x-delay']).toBeLessThanOrEqual(36 * 60 * 1000);
        });

        // H8 — resetAt in the past (clock skew / already reset).
        it('clips delay to (0 + buffer) when resetAt is in the past', async () => {
            const { handler, amqpConnection } = makeHandler();
            const channel = { ack: jest.fn() };
            const msg = makeMessage();
            const resetAt = new Date(Date.now() - 60 * 1000); // 1 min ago

            await handler.handle(
                channel,
                msg,
                new RateLimitError({ resetAt, remaining: 0 }),
            );

            const headers = (amqpConnection.publish.mock.calls[0][3] as any)
                .headers;
            // Past resetAt → raw wait clipped to 0, just the 5min buffer.
            expect(headers['x-delay']).toBeGreaterThanOrEqual(5 * 60 * 1000);
            expect(headers['x-delay']).toBeLessThan(6 * 60 * 1000);
        });

        // H9 — resetAt absurdly far in the future (corrupted header).
        it('caps delay at 1 hour even when resetAt is days away', async () => {
            const { handler, amqpConnection } = makeHandler();
            const channel = { ack: jest.fn() };
            const msg = makeMessage();
            const resetAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days

            await handler.handle(
                channel,
                msg,
                new RateLimitError({ resetAt, remaining: 0 }),
            );

            const headers = (amqpConnection.publish.mock.calls[0][3] as any)
                .headers;
            expect(headers['x-delay']).toBeLessThanOrEqual(60 * 60 * 1000);
        });

        // Duck-typed recognition: plain objects with the right shape
        // should also trigger the rate-limit branch.
        it('recognizes a plain object carrying errorClassification=RATE_LIMITED + resetAt', async () => {
            const { handler, amqpConnection } = makeHandler();
            const channel = { ack: jest.fn() };
            const msg = makeMessage();
            const resetAt = new Date(Date.now() + 10 * 60 * 1000);
            const plainError = {
                errorClassification: 'RATE_LIMITED',
                resetAt,
                message: 'serialized rate limit',
            };

            await handler.handle(channel, msg, plainError as any);

            const headers = (amqpConnection.publish.mock.calls[0][3] as any)
                .headers;
            // Around 10 + 5 = 15 min ± drift.
            expect(headers['x-delay']).toBeGreaterThan(14 * 60 * 1000);
        });

        // H11 — RATE_LIMITED still counts toward the retry budget.
        // (Design choice: not exempted, but the lower default-2 helps
        // bound the worst case.)
        it('still increments retry count and goes to DLQ after maxRetries', async () => {
            const { handler, amqpConnection } = makeHandler({ maxRetries: 2 });
            const channel = { ack: jest.fn() };
            const msg = makeMessage({ 'x-retry-count': 2 });

            await handler.handle(
                channel,
                msg,
                new RateLimitError({
                    resetAt: new Date(Date.now() + 60_000),
                }),
                { dlqRoutingKey: 'workflow.job.failed' },
            );

            // Goes to DLQ (exchange ends in `.dlx`), not delayed retry
            expect(amqpConnection.publish).toHaveBeenCalledWith(
                'workflow.exchange.dlx',
                'workflow.job.failed',
                msg.content,
                expect.any(Object),
            );
        });
    });

    it('nacks without requeue when the singleton handler is unavailable', () => {
        const fallback = createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        );
        const channel = { nack: jest.fn() };
        const msg = makeMessage();

        fallback(channel, msg, new Error('processor failed'));

        expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });
});
