import {
    MAX_DRAIN_TIMEOUT_MS,
    parseDrainTimeoutMs,
} from '@libs/core/workflow/infrastructure/drain-timeout';
import {
    SHUTDOWN_AFTER_DRAIN_MS,
    WorkerDrainService,
} from './worker-drain.service';
import { forceExitAfterMs } from './worker-health-guard.service';

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

        await new WorkerDrainService(
            amqpConnection as any,
        ).onApplicationShutdown('SIGTERM');

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

        await new WorkerDrainService(
            amqpConnection as any,
        ).onApplicationShutdown('SIGTERM');

        expect(amqpConnection.cancelConsumer).toHaveBeenCalledTimes(2);
        expect(amqpConnection.close).toHaveBeenCalled();
    });

    it('still closes when a cancel never settles (half-open connection)', async () => {
        jest.useFakeTimers();
        try {
            const amqpConnection = {
                consumerTags: ['stuck'],
                cancelConsumer: jest.fn(() => new Promise(() => {})),
                close: jest.fn().mockResolvedValue(undefined),
            };

            const done = new WorkerDrainService(
                amqpConnection as any,
            ).onApplicationShutdown('SIGTERM');
            await jest.advanceTimersByTimeAsync(5_000);
            await done;

            expect(amqpConnection.close).toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it('still closes when reading the consumer registry throws', async () => {
        const amqpConnection = {
            get consumerTags(): string[] {
                throw new Error('registry gone');
            },
            cancelConsumer: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        await new WorkerDrainService(
            amqpConnection as any,
        ).onApplicationShutdown('SIGTERM');

        expect(amqpConnection.close).toHaveBeenCalled();
    });

    it('is a no-op without an AMQP connection', async () => {
        await expect(
            new WorkerDrainService(undefined).onApplicationShutdown('SIGTERM'),
        ).resolves.toBeUndefined();
    });

    it('cancels consumers in onModuleDestroy and closes only in onApplicationShutdown', async () => {
        const order: string[] = [];
        const amqpConnection = {
            consumerTags: ['tag-code-review'],
            cancelConsumer: jest.fn(async (tag: string) => {
                order.push(`cancel:${tag}`);
            }),
            close: jest.fn(async () => {
                order.push('close');
            }),
        };
        const drain = new WorkerDrainService(amqpConnection as any);

        await drain.onModuleDestroy();
        expect(order).toEqual(['cancel:tag-code-review']);

        // The job drain (WorkflowJobConsumer.beforeApplicationShutdown)
        // runs here, with consumers cancelled and the connection still open.

        await drain.onApplicationShutdown('SIGTERM');
        expect(order).toEqual(['cancel:tag-code-review', 'close']);
        // Not cancelled twice
        expect(amqpConnection.cancelConsumer).toHaveBeenCalledTimes(1);
    });

    it('retries only the consumers whose cancel failed before closing', async () => {
        const amqpConnection = {
            consumerTags: ['a', 'b'],
            cancelConsumer: jest
                .fn()
                .mockRejectedValueOnce(new Error('channel closed'))
                .mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const drain = new WorkerDrainService(amqpConnection as any);

        await drain.onModuleDestroy();
        await drain.onApplicationShutdown('SIGTERM');

        expect(
            amqpConnection.cancelConsumer.mock.calls.map(([t]) => t),
        ).toEqual(['a', 'b', 'a']);
        expect(amqpConnection.close).toHaveBeenCalled();
    });

    it('gives the close its own short budget, not a second drain budget', async () => {
        jest.useFakeTimers();
        const prev = process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        process.env.API_WORKER_DRAIN_TIMEOUT_MS = '240000';
        try {
            const amqpConnection = {
                consumerTags: [],
                cancelConsumer: jest.fn(),
                close: jest.fn(() => new Promise(() => {})),
            };
            let settled = false;
            const done = new WorkerDrainService(amqpConnection as any)
                .onApplicationShutdown('SIGTERM')
                .then(() => {
                    settled = true;
                });

            await jest.advanceTimersByTimeAsync(15_000);
            await done;
            expect(settled).toBe(true);
        } finally {
            if (prev === undefined)
                delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
            else process.env.API_WORKER_DRAIN_TIMEOUT_MS = prev;
            jest.useRealTimers();
        }
    });

    it('force-exits only after the drain budget plus every bounded step after it', () => {
        const prev = process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        process.env.API_WORKER_DRAIN_TIMEOUT_MS = '240000';
        try {
            // 2 cancels (5s each) + close (15s) + inbox release room (10s)
            expect(SHUTDOWN_AFTER_DRAIN_MS).toBe(25_000);
            expect(forceExitAfterMs()).toBe(240_000 + 25_000 + 10_000);
        } finally {
            if (prev === undefined)
                delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
            else process.env.API_WORKER_DRAIN_TIMEOUT_MS = prev;
        }
    });

    it.each([
        ['an extra zero', '2400000000'],
        ['above the ceiling', String(MAX_DRAIN_TIMEOUT_MS + 1)],
        ['zero', '0'],
        ['not a number', 'soon'],
    ])('falls back to the default drain budget for %s', (_label, value) => {
        const prev = process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        process.env.API_WORKER_DRAIN_TIMEOUT_MS = value;
        try {
            expect(parseDrainTimeoutMs()).toBe(25_000);
        } finally {
            if (prev === undefined)
                delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
            else process.env.API_WORKER_DRAIN_TIMEOUT_MS = prev;
        }
    });

    it('keeps a drain budget inside the bounds', () => {
        const prev = process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        process.env.API_WORKER_DRAIN_TIMEOUT_MS = '240000';
        try {
            expect(parseDrainTimeoutMs()).toBe(240_000);
        } finally {
            if (prev === undefined)
                delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
            else process.env.API_WORKER_DRAIN_TIMEOUT_MS = prev;
        }
    });

    it('uses the default drain budget, and sizes the force-exit from it, when the variable is unset', () => {
        const prev = process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        try {
            expect(parseDrainTimeoutMs()).toBe(25_000);
            expect(forceExitAfterMs()).toBe(25_000 + 25_000 + 10_000);
        } finally {
            if (prev !== undefined)
                process.env.API_WORKER_DRAIN_TIMEOUT_MS = prev;
        }
    });
});
