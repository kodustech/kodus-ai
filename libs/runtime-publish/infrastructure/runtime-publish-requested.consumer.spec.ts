import { RuntimePublishRequestedConsumer } from './runtime-publish-requested.consumer';

// One queue carries every publication of the Runtime; the consumer hands each to the use case of its event.
describe('RuntimePublishRequestedConsumer', () => {
    const wire = (event_name: string) => ({ event_name, payload: {}, event_version: 1, occurred_on: new Date(), messageId: 'm' });

    it('hands a suite publication to the suite use case and every other delivery to the Run use case', async () => {
        const run = { execute: jest.fn(async () => undefined) };
        const suite = { execute: jest.fn(async () => undefined) };
        const consumer = new RuntimePublishRequestedConsumer(run as any, suite as any);
        await consumer.handle(wire('runtime.suite.publish_requested'));
        await consumer.handle(wire('runtime.publish.requested'));
        await consumer.handle('not an envelope');
        expect(suite.execute).toHaveBeenCalledTimes(1);
        expect(run.execute).toHaveBeenCalledTimes(2);
    });

    it('lets a failed publication throw, so the shared error handler retries it', async () => {
        const consumer = new RuntimePublishRequestedConsumer({ execute: jest.fn() } as any, { execute: jest.fn(async () => Promise.reject(new Error('platform down'))) } as any);
        await expect(consumer.handle(wire('runtime.suite.publish_requested'))).rejects.toThrow('platform down');
    });
});
