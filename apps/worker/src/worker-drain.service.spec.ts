import { WorkerDrainService } from './worker-drain.service';

describe('WorkerDrainService', () => {
    it('cancels every registered consumer before closing the connection', async () => {
        const order: string[] = [];
        const amqpConnection = {
            consumerTags: ['tag-webhook', 'tag-code-review'],
            cancelConsumer: jest.fn(async (tag: string) => {
                order.push(`cancel:${tag}`);
            }),
            close: jest.fn(async () => {
                order.push('close');
            }),
        };

        await new WorkerDrainService(amqpConnection as any).onApplicationShutdown(
            'SIGTERM',
        );

        expect(order).toEqual([
            'cancel:tag-webhook',
            'cancel:tag-code-review',
            'close',
        ]);
    });

    it('still closes the connection when a cancel fails', async () => {
        const amqpConnection = {
            consumerTags: ['a', 'b'],
            cancelConsumer: jest
                .fn()
                .mockRejectedValueOnce(new Error('channel closed'))
                .mockResolvedValueOnce(undefined),
            close: jest.fn().mockResolvedValue(undefined),
        };

        await new WorkerDrainService(amqpConnection as any).onApplicationShutdown(
            'SIGTERM',
        );

        expect(amqpConnection.cancelConsumer).toHaveBeenCalledTimes(2);
        expect(amqpConnection.close).toHaveBeenCalled();
    });

    it('is a no-op without an AMQP connection', async () => {
        await expect(
            new WorkerDrainService(undefined).onApplicationShutdown('SIGTERM'),
        ).resolves.toBeUndefined();
    });
});
