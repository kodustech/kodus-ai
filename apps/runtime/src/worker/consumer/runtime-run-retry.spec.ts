import { InMemoryPrAdmissionStore } from '../../shared/pr-admission-store';
import {
    AmqpConnection,
    MessageHandlerErrorBehavior,
    Nack,
    RABBIT_HANDLER,
} from '@golevelup/nestjs-rabbitmq';
import { Logger } from '@nestjs/common';
import { dirname, join } from 'path';
import type { ConsumeMessage } from 'amqplib';
import { AmqpConnectionManagerClass } from 'amqp-connection-manager';

import {
    RuntimeEventName,
    runtimeEnvelope,
} from '@libs/runtime/run/run-messages';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';

import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryCommandStore } from '../../shared/pg-command-store';
import { RuntimeCommandConsumer } from './run-request.consumer';
import {
    RuntimeRunRetry,
    runtimeRunErrorHandler,
    deserializeRuntimeCommand,
} from './runtime-run-retry';

const raw = (value: unknown, count?: unknown) =>
    ({
        content: Buffer.from(JSON.stringify(value)),
        properties: {
            contentEncoding: undefined,
            deliveryMode: 2,
            priority: undefined,
            replyTo: undefined,
            expiration: undefined,
            timestamp: undefined,
            type: undefined,
            userId: undefined,
            appId: undefined,
            clusterId: undefined,
            messageId: 'message-1',
            correlationId: 'correlation-1',
            contentType: 'application/json',
            headers: {
                original: 'preserved',
                ...(count === undefined ? {} : { 'x-retry-count': count }),
            },
        },
        fields: {
            exchange: 'workflow.exchange',
            routingKey: 'workflow.jobs.created.RUNTIME_RUN',
            deliveryTag: 1,
            consumerTag: 'fixture',
            redelivered: false,
        },
    }) as ConsumeMessage;

function fixture() {
    const publish = jest.fn(async (..._args: any[]) => true);
    const retry = new RuntimeRunRetry(
        { publish },
        { maxRetries: 2, delayMs: 100, maxDelayMs: 30000 },
    );
    const canonical = new Set<string>();
    const engine = {
        start: jest.fn(async (req: { runId: string }) => {
            canonical.add(req.runId);
            return req.runId;
        }),
        stop: jest.fn(async () => undefined),
        approve: jest.fn(async () => undefined),
        startSetup: jest.fn(async (req: { key: string }) => {
            canonical.add(req.key);
            return req.key;
        }),
    };
    const consumer = new RuntimeCommandConsumer(
        engine as any,
        new InMemoryRunProjectionStore(),
        new InMemoryCommandStore(), new InMemoryPrAdmissionStore(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        retry,
    );
    const channel = { ack: jest.fn(), nack: jest.fn() };
    return { publish, retry, canonical, engine, consumer, channel };
}

/** The real installed subscriber owns ACK/error callback ordering; no hand-written ACK simulator. */
async function subscriber(
    consumer: RuntimeCommandConsumer,
    channel: any,
    log: any,
) {
    let receive!: (msg: ConsumeMessage) => Promise<void>;
    channel.consume = jest.fn(async (_queue, handler) => {
        receive = handler;
        return { consumerTag: 'fixture' };
    });
    const options = Reflect.getMetadata(
        RABBIT_HANDLER,
        RuntimeCommandConsumer.prototype.onMessage,
    );
    const connection = {
        setupQueue: async () => 'fixture',
        wrapConsumer: (fn: unknown) => fn,
        deserializeMessage: (AmqpConnection.prototype as any)
            .deserializeMessage,
        registerConsumerForQueue: jest.fn(),
        logger: log,
        config: {
            deserializer: (b: Buffer) => JSON.parse(b.toString()),
            defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.NACK,
        },
    };
    await (AmqpConnection.prototype as any).setupSubscriberChannel.call(
        connection,
        consumer.onMessage.bind(consumer),
        options,
        channel,
    );
    return receive;
}

describe('Runtime-scoped confirmed Run retry', () => {
    it('preserves bytes/identity and ACKs only after a confirmed retry, then admits one canonical Run', async () => {
        const { consumer, publish, engine, canonical, channel } = fixture();
        const req = shopRunRequest();
        const input = raw(
            runtimeEnvelope(RuntimeEventName.RunRequested, req, 'envelope-1'),
        );
        engine.start.mockRejectedValueOnce(
            new Error('SECRET upstream credentials'),
        );
        let confirm!: (value: boolean) => void;
        publish.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    confirm = resolve;
                }),
        );
        const log = { error: jest.fn(), warn: jest.fn() };
        const receive = await subscriber(consumer, channel, log);
        const pending = receive(input);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(publish).toHaveBeenCalledTimes(1);
        expect(channel.ack).not.toHaveBeenCalled();
        const [exchange, key, bytes, properties] = publish.mock.calls[0];
        expect(exchange).toBe('workflow.exchange.runtime_run_retry');
        expect(key).toBe(input.fields.routingKey);
        expect(bytes).toBe(input.content);
        expect(properties).toMatchObject({
            messageId: 'message-1',
            correlationId: 'correlation-1',
            persistent: true,
            deliveryMode: 2,
            timeout: 5000,
            headers: {
                'original': 'preserved',
                'x-retry-count': 1,
                'x-delay': { '!': 'int', 'value': 100 },
            },
        });
        expect(JSON.stringify(log.error.mock.calls)).not.toContain('SECRET');
        confirm(false); // confirmed false is backpressure, not rejection.
        await pending;
        expect(channel.ack).toHaveBeenCalledWith(input);
        expect(channel.nack).not.toHaveBeenCalled();
        expect(input.properties.headers).not.toHaveProperty('x-retry-count');
        const redelivered = {
            ...input,
            fields: { ...input.fields, exchange },
            properties,
        };
        await receive(redelivered);
        expect(canonical).toEqual(new Set([req.runId]));
        expect(engine.start.mock.calls.map(([r]) => r.runId)).toEqual([
            req.runId,
            req.runId,
        ]);
        expect(channel.ack).toHaveBeenCalledTimes(2);
    });

    it('retries setup using its same deterministic key, and a durable-then-lost Run uses the same identity', async () => {
        const { consumer, retry, engine, canonical, channel, publish } =
            fixture();
        const setup = {
            environmentId: 'env-1',
            organizationId: 'o',
            teamId: 't',
            repositoryId: 'r',
            repositoryName: 'acme/shop',
            requestedBy: { userId: 'u' },
            requestedAt: new Date().toISOString(),
            key: 'setup-identity',
        };
        engine.startSetup.mockRejectedValueOnce(new Error('temporary outage'));
        const setupMessage = raw(
            runtimeEnvelope(
                RuntimeCommandName.EnvironmentSetupRequested,
                setup,
                'm',
            ),
        );
        const failure = await consumer
            .onMessage(
                JSON.parse(setupMessage.content.toString()),
                setupMessage,
            )
            .catch((e) => e);
        await runtimeRunErrorHandler(channel as any, setupMessage, failure);
        const retryProperties = publish.mock.calls[0][3];
        await consumer.onMessage(JSON.parse(setupMessage.content.toString()), {
            ...setupMessage,
            properties: retryProperties,
        });
        expect(canonical).toEqual(new Set([setup.key]));
        expect(engine.startSetup.mock.calls.map(([r]) => r.key)).toEqual([
            setup.key,
            setup.key,
        ]);

        const req = shopRunRequest();
        const msg = raw(
            runtimeEnvelope(RuntimeEventName.RunRequested, req, 'm'),
        );
        engine.start.mockImplementationOnce(async (r) => {
            canonical.add(r.runId);
            throw new Error('ACK path lost after durable commit');
        });
        const committedFailure = await consumer
            .onMessage(JSON.parse(msg.content.toString()), msg)
            .catch((e) => e);
        await runtimeRunErrorHandler(channel as any, msg, committedFailure);
        await consumer.onMessage(JSON.parse(msg.content.toString()), {
            ...msg,
            properties: publish.mock.calls.at(-1)![3],
        });
        expect([...canonical].filter((id) => id === req.runId)).toEqual([
            req.runId,
        ]);
        expect(retry).toBeDefined();
    });

    it.each(['1', -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, null, {}, []])(
        'rejects malformed retry counter %p before dispatch',
        async (count) => {
            const { consumer, engine, publish } = fixture();
            const msg = raw(
                runtimeEnvelope(
                    RuntimeEventName.RunRequested,
                    shopRunRequest(),
                    'm',
                ),
                count,
            );
            expect(
                await consumer.onMessage(
                    JSON.parse(msg.content.toString()),
                    msg,
                ),
            ).toBeInstanceOf(Nack);
            expect(engine.start).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();
        },
    );

    it('exhausts once through native DLX and never retries a conflict or unknown library error', async () => {
        const { consumer, engine, publish, channel } = fixture();
        const msg = raw(
            runtimeEnvelope(
                RuntimeEventName.RunRequested,
                shopRunRequest(),
                'm',
            ),
            2,
        );
        engine.start.mockRejectedValueOnce(new Error('temporary'));
        const error = await consumer
            .onMessage(JSON.parse(msg.content.toString()), msg)
            .catch((e) => e);
        await runtimeRunErrorHandler(channel as any, msg, error);
        expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
        expect(publish).not.toHaveBeenCalled();
        engine.start.mockRejectedValueOnce(
            Object.assign(new Error('SECRET conflict'), {
                code: 'admission_conflict',
            }),
        );
        expect(
            await consumer.onMessage(
                JSON.parse(msg.content.toString()),
                raw(JSON.parse(msg.content.toString())),
            ),
        ).toBeInstanceOf(Nack);
        await runtimeRunErrorHandler(
            channel as any,
            msg,
            new Error('SECRET invalid JSON'),
        );
        expect(publish).not.toHaveBeenCalled();
    });

    it('leaves the original unacked/un-nacked after retry publication fails, with closed diagnostics', async () => {
        const { retry, publish, channel } = fixture();
        publish.mockRejectedValueOnce(
            new Error('SECRET broker connection URL'),
        );
        const msg = raw({});
        const log = jest
            .spyOn(Logger.prototype, 'error')
            .mockImplementation(() => undefined);
        try {
            await expect(
                runtimeRunErrorHandler(channel as any, msg, retry.failure()),
            ).rejects.toThrow('runtime_run_retry_publish_failed');
            expect(channel.ack).not.toHaveBeenCalled();
            expect(channel.nack).not.toHaveBeenCalled();
            expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
        } finally {
            log.mockRestore();
        }
    });

    it('cancels a disconnected publisher queue through the installed transport timeout', async () => {
        jest.useFakeTimers();
        // Constructing the manager does not connect; no network, broker or fake queue implementation.
        const manager = new AmqpConnectionManagerClass([]);
        const wrapper = manager.createChannel({ confirm: true });
        const facade = {
            _managedChannel: wrapper,
            config: { defaultPublishOptions: {}, serializer: JSON.stringify },
        };
        const retry = new RuntimeRunRetry(
            { publish: (AmqpConnection.prototype.publish as any).bind(facade) },
            { maxRetries: 2, delayMs: 100, maxDelayMs: 30000 },
        );
        const channel = { ack: jest.fn(), nack: jest.fn() };
        const log = jest
            .spyOn(Logger.prototype, 'error')
            .mockImplementation(() => undefined);
        try {
            const failed = expect(
                runtimeRunErrorHandler(
                    channel as any,
                    raw({}),
                    retry.failure(),
                ),
            ).rejects.toThrow('runtime_run_retry_publish_failed');
            expect(wrapper.queueLength()).toBe(1);
            await jest.advanceTimersByTimeAsync(5000);
            await failed;
            expect(wrapper.queueLength()).toBe(0);
            expect(channel.ack).not.toHaveBeenCalled();
            expect(channel.nack).not.toHaveBeenCalled();
        } finally {
            await manager.close();
            log.mockRestore();
            jest.useRealTimers();
        }
    });

    it('drops inherited raw diagnostic headers and caps backoff without changing the original', async () => {
        const { retry, publish, channel } = fixture();
        const msg = raw({}, 1);
        msg.properties.headers!['x-last-error'] = 'SECRET';
        await runtimeRunErrorHandler(channel as any, msg, retry.failure());
        expect(publish.mock.calls[0][3].headers).not.toHaveProperty(
            'x-last-error',
        );
        expect(publish.mock.calls[0][3].headers['x-delay']).toEqual({
            '!': 'int',
            'value': 200,
        });
        const codec = require(
            join(dirname(require.resolve('amqplib')), 'lib/codec.js'),
        );
        const table = Buffer.alloc(128);
        codec.encodeTable(
            table,
            { 'x-delay': publish.mock.calls[0][3].headers['x-delay'] },
            0,
        );
        expect(String.fromCharCode(table[12])).toBe('I'); // signed int32, never signed byte for short delays.
        expect(msg.properties.headers!['x-last-error']).toBe('SECRET');
    });

    it.each(['{ invalid SECRET', 'null', '[]', '"SECRET"'])(
        'dead-letters invalid JSON/root shape %s without throwing raw parser errors',
        async (text) => {
            const { consumer, engine, channel } = fixture();
            const log = { error: jest.fn(), warn: jest.fn() };
            const receive = await subscriber(consumer, channel, log);
            const msg = { ...raw({}), content: Buffer.from(text) };
            await receive(msg);
            expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
            expect(channel.ack).not.toHaveBeenCalled();
            expect(engine.start).not.toHaveBeenCalled();
            expect(log.error).not.toHaveBeenCalled();
            expect(() =>
                deserializeRuntimeCommand(Buffer.from(text)),
            ).not.toThrow();
        },
    );
});
