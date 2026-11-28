import { consumerWith } from './testing';
import { AmqpConnection, MessageHandlerErrorBehavior, RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import type { ConsumeMessage } from 'amqplib';

import { RUNTIME_CONTROL_ROUTING_KEY, RUNTIME_RUN_RETRY_EXCHANGE } from '@libs/runtime/run/run-messages';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';

import { RuntimeCommandConsumer } from './run-request.consumer';
import { RuntimeRunRetry } from './runtime-run-retry';
import { InMemoryPrAdmissionStore } from '../../shared/admission/testing';
import { InMemoryCommandStore } from '../../shared/persistence/testing';

const delivery = (value: unknown, count?: number) =>
    ({
        content: Buffer.from(JSON.stringify(value)),
        properties: { messageId: 'message-1', contentType: 'application/json', headers: count === undefined ? {} : { 'x-retry-count': count } },
        fields: { exchange: 'workflow.exchange', routingKey: RUNTIME_CONTROL_ROUTING_KEY, deliveryTag: 1, consumerTag: 'fixture', redelivered: false },
    }) as unknown as ConsumeMessage;

const stop = () => ({
    event_name: RuntimeCommandName.StopRequested,
    payload: { scope: 'global', requestedBy: { userId: 'a' }, requestedAt: new Date().toISOString(), correlationId: 'c' },
});

/** The installed subscriber drives onControl, so its errorHandler and ack ordering are the real ones. */
async function controlSubscriber(consumer: RuntimeCommandConsumer, channel: any) {
    let receive!: (msg: ConsumeMessage) => Promise<void>;
    channel.consume = jest.fn(async (_queue: string, handler: typeof receive) => {
        receive = handler;
        return { consumerTag: 'fixture' };
    });
    const options = Reflect.getMetadata(RABBIT_HANDLER, RuntimeCommandConsumer.prototype.onControl);
    const connection = {
        setupQueue: async () => 'fixture',
        wrapConsumer: (fn: unknown) => fn,
        deserializeMessage: (AmqpConnection.prototype as any).deserializeMessage,
        registerConsumerForQueue: jest.fn(),
        logger: { error: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() },
        config: { deserializer: (b: Buffer) => JSON.parse(b.toString()), defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.NACK },
    };
    await (AmqpConnection.prototype as any).setupSubscriberChannel.call(connection, consumer.onControl.bind(consumer), options, channel);
    return receive;
}

function fixture() {
    const publish = jest.fn(async (..._args: unknown[]) => true);
    const retry = new RuntimeRunRetry({ publish }, { maxRetries: 2, delayMs: 100, maxDelayMs: 30000 });
    const commands = new InMemoryCommandStore();
    const engine = { start: jest.fn(), stop: jest.fn(), approve: jest.fn(), startSetup: jest.fn() };
    const consumer = consumerWith({ engine: engine as any, projection: new InMemoryRunProjectionStore(), commands, admissions: new InMemoryPrAdmissionStore() }, retry);
    const channel: any = { ack: jest.fn(), nack: jest.fn() };
    return { publish, commands, consumer, channel };
}

describe('Runtime control lane retry', () => {
    it('retries a control command whose handler fails transiently, with delay on the private retry exchange', async () => {
        const { publish, commands, consumer, channel } = fixture();
        jest.spyOn(commands, 'recordStop').mockRejectedValueOnce(new Error('connection terminated'));
        const receive = await controlSubscriber(consumer, channel);
        await receive(delivery(stop()));
        expect(publish).toHaveBeenCalledTimes(1);
        const [exchange, key, , options] = publish.mock.calls[0] as [string, string, Buffer, { headers: Record<string, unknown> }];
        expect([exchange, key]).toEqual([RUNTIME_RUN_RETRY_EXCHANGE, RUNTIME_CONTROL_ROUTING_KEY]);
        expect(options.headers['x-retry-count']).toBe(1);
        expect(channel.ack).toHaveBeenCalledTimes(1);
        expect(channel.nack).not.toHaveBeenCalled();
    });

    it('dead-letters a schema-invalid control command without a retry', async () => {
        const { publish, consumer, channel } = fixture();
        const receive = await controlSubscriber(consumer, channel);
        await receive(delivery({ event_name: RuntimeCommandName.StopRequested, payload: { scope: 'nowhere' } }));
        expect(publish).not.toHaveBeenCalled();
        expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    });

    it('dead-letters a transient failure once the retries are spent', async () => {
        const { publish, commands, consumer, channel } = fixture();
        jest.spyOn(commands, 'recordStop').mockRejectedValue(new Error('connection terminated'));
        const receive = await controlSubscriber(consumer, channel);
        await receive(delivery(stop(), 2));
        expect(publish).not.toHaveBeenCalled();
        expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    });
});
