import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as runMessages from '@libs/runtime/run/run-messages';

import { RabbitMQDLQInitializer } from './rabbitmq-dlq.initializer';

const ROOT = resolve(__dirname, '../../../..');

/** Production files of the Runtime folders. */
function runtimeSources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : runtimeSources(path);
        return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [path] : [];
    });
}

// The Kody Runtime queues are consumed by another app (the runtime-worker).
// Until it has declared its binding, a command the product publishes on
// workflow.exchange found no queue and was dropped (a stop lost on a deploy
// where the product came up first). The product now binds them itself.
describe('RabbitMQDLQInitializer', () => {
    const channel = () => {
        const binds: Array<[string, string, string]> = [];
        const bindArgs: Array<[string, string, Record<string, unknown> | undefined]> = [];
        return {
            binds,
            bindArgs,
            assertExchange: jest.fn(async () => undefined),
            assertQueue: jest.fn(async () => undefined),
            bindQueue: jest.fn(async (q: string, ex: string, key: string, args?: Record<string, unknown>) => {
                binds.push([q, ex, key]);
                bindArgs.push([q, ex, args]);
            }),
        };
    };

    it('binds the Runtime queues to workflow.exchange, and only those', async () => {
        const ch = channel();
        const init = new RabbitMQDLQInitializer({ channel: ch, managedChannel: { addSetup: jest.fn() } } as any);
        await init.onApplicationBootstrap();
        const main = ch.binds.filter(([, ex]) => ex === 'workflow.exchange');
        expect(main).toEqual(
            expect.arrayContaining([
                ['workflow.jobs.runtime_run.queue', 'workflow.exchange', 'workflow.jobs.*.RUNTIME_RUN'],
                ['workflow.jobs.runtime_control.queue', 'workflow.exchange', 'workflow.jobs.*.RUNTIME_CONTROL'],
            ]),
        );
        expect(main.every(([q]) => q.startsWith('workflow.jobs.runtime_'))).toBe(true);
        // Every queue still gets its delayed-retry binding.
        expect(ch.binds.filter(([, ex]) => ex === 'workflow.exchange.delayed').map(([q]) => q)).toEqual(
            expect.arrayContaining(['workflow.jobs.code_review.queue', 'workflow.jobs.runtime_control.queue']),
        );
    });

    /**
     * A broker connection with the product's channel and, for the Runtime's retry topology, a
     * channel of its own. Each setup the Runtime channel gets runs once, as on a connect.
     */
    const connection = (product = channel(), runtime = channel()) => {
        const runtimeSetups: Array<Promise<unknown>> = [];
        const runtimeErrors: unknown[] = [];
        const createChannel = jest.fn((opts: { setup: (ch: unknown) => Promise<unknown> }) => {
            runtimeSetups.push(opts.setup(runtime).catch((err) => runtimeErrors.push(err)));
            return { on: jest.fn(), close: jest.fn(async () => undefined) };
        });
        const amqp = {
            channel: product,
            managedChannel: { addSetup: jest.fn() },
            managedConnection: { createChannel },
        };
        return { amqp, product, runtime, createChannel, settled: () => Promise.all(runtimeSetups), runtimeErrors };
    };
    const runtimeExchanges = ['workflow.exchange.runtime_retry', 'workflow.exchange.runtime_retry.return'];
    const touchesRuntimeRetry = (ch: ReturnType<typeof channel>) =>
        ch.assertExchange.mock.calls.some((c: unknown[]) => runtimeExchanges.includes(c[0] as string)) ||
        ch.assertQueue.mock.calls.some((c: unknown[]) => String(c[0]).startsWith('workflow.jobs.runtime_retry.')) ||
        ch.binds.some(([q, ex]) => runtimeExchanges.includes(ex) || q.startsWith('workflow.jobs.runtime_retry.'));
    const withRuntime = (value: string | undefined, fn: () => Promise<void>) => async () => {
        const before = process.env.RUNTIME_ENABLED;
        if (value === undefined) delete process.env.RUNTIME_ENABLED;
        else process.env.RUNTIME_ENABLED = value;
        try {
            await fn();
        } finally {
            if (before === undefined) delete process.env.RUNTIME_ENABLED;
            else process.env.RUNTIME_ENABLED = before;
        }
    };

    // With the Runtime off, the product's topology is main's: no Runtime retry exchange, wait
    // queue or return edge is declared, so nothing the Runtime needs can fail the product's setup.
    it(
        'declares no Runtime retry topology where the Runtime is off',
        withRuntime('false', async () => {
            const c = connection();
            await new RabbitMQDLQInitializer(c.amqp as any).onApplicationBootstrap();
            const setup = c.amqp.managedChannel.addSetup.mock.calls[0][0];
            await setup(c.product);
            expect(touchesRuntimeRetry(c.product)).toBe(false);
            expect(c.createChannel).not.toHaveBeenCalled();
        }),
    );

    // The retry topology carries arguments an older or drifted broker can refuse (quorum,
    // at-least-once dead-lettering). A refused declaration closes the channel it ran on, so it
    // runs on a channel of its own: the product's channel and its consumers never see it.
    it(
        'declares the Runtime retry topology on its own channel, and a refusal there leaves the product setup whole',
        withRuntime('true', async () => {
            const runtime = channel();
            runtime.assertQueue.mockImplementation(async (name: string) => {
                if (name.startsWith('workflow.jobs.runtime_retry.wait.'))
                    throw new Error('PRECONDITION_FAILED fixture');
            });
            const c = connection(channel(), runtime);
            await new RabbitMQDLQInitializer(c.amqp as any).onApplicationBootstrap();
            const setup = c.amqp.managedChannel.addSetup.mock.calls[0][0];
            await expect(setup(c.product)).resolves.toBeUndefined();
            await c.settled();
            expect(c.createChannel).toHaveBeenCalledTimes(1);
            expect(c.runtimeErrors).toHaveLength(1);
            expect(touchesRuntimeRetry(c.product)).toBe(false);
            expect(c.product.binds.filter(([, ex]) => ex === 'workflow.exchange.delayed').map(([q]) => q)).toEqual(
                expect.arrayContaining(['workflow.jobs.code_review.queue']),
            );
        }),
    );

    // No delayed-message plugin (kodus-ai#1663): each delay waits in a quorum queue whose TTL
    // dead-letters to a return exchange bound to exactly the Run and control lanes.
    it(
        'owns a private retry of wait queues that returns to exactly the canonical Run and control edges',
        withRuntime('true', async () => {
            const c = connection();
            const init = new RabbitMQDLQInitializer(c.amqp as any);
            await init.onApplicationBootstrap();
            await c.settled();
            const ch = c.runtime;
            expect(ch.assertExchange).toHaveBeenCalledWith('workflow.exchange.runtime_retry', 'headers', { durable: true });
            expect(ch.assertExchange).toHaveBeenCalledWith('workflow.exchange.runtime_retry.return', 'direct', { durable: true });
            expect(ch.assertExchange).not.toHaveBeenCalledWith('workflow.exchange.runtime_retry', 'x-delayed-message', expect.anything());
            expect(ch.binds.filter(([, exchange]) => exchange === 'workflow.exchange.runtime_retry.return')).toEqual([
                ['workflow.jobs.runtime_run.queue', 'workflow.exchange.runtime_retry.return', 'workflow.jobs.created.RUNTIME_RUN'],
                ['workflow.jobs.runtime_control.queue', 'workflow.exchange.runtime_retry.return', 'workflow.jobs.created.RUNTIME_CONTROL'],
            ]);
            const waits = ch.bindArgs.filter(([, exchange]) => exchange === 'workflow.exchange.runtime_retry');
            expect(waits.map(([q, , args]) => [q, args])).toEqual(
                runMessages.RUNTIME_RETRY_DELAYS_MS.map((ms) => [
                    `workflow.jobs.runtime_retry.wait.${ms}ms`,
                    { 'x-match': 'all', 'kodus-runtime-retry-delay-ms': String(ms) },
                ]),
            );
            expect(ch.assertQueue).toHaveBeenCalledWith('workflow.jobs.runtime_retry.wait.1000ms', {
                durable: true,
                arguments: {
                    'x-queue-type': 'quorum',
                    'x-message-ttl': 1000,
                    'x-dead-letter-exchange': 'workflow.exchange.runtime_retry.return',
                    'x-dead-letter-strategy': 'at-least-once',
                    'x-overflow': 'reject-publish',
                },
            });
            await init.onModuleDestroy();
        }),
    );

    it('waits a backoff in the shortest wait queue that is not shorter, at most the longest', () => {
        expect([1, 999, 1000, 1001, 30_000, 60_000, 600_000].map(runMessages.runtimeRetryDelay)).toEqual([
            1000, 1000, 1000, 2000, 32_000, 60_000, 60_000,
        ]);
    });

    // The shared error handler republishes a failed message on workflow.exchange.delayed with its own
    // routing key; a Runtime queue missing there loses every retry in silence.
    it('binds on the delayed exchange every Runtime queue consumed with the shared error handler', async () => {
        const consumed = ['libs/runtime', 'libs/runtime-publish', 'apps/runtime/src']
            .flatMap((d) => runtimeSources(join(ROOT, d)))
            .map((f) => readFileSync(f, 'utf8'))
            .filter((src) => src.includes('createRabbitMQErrorHandlerWithFallback('))
            .flatMap((src) => [...src.matchAll(/queue:\s*(\w+)/g)].map((m) => m[1]));
        const queues = consumed.map((name) => (runMessages as Record<string, unknown>)[name]);
        expect(queues).toEqual(expect.arrayContaining([runMessages.RUNTIME_TRIGGER_QUEUE, runMessages.RUNTIME_PUBLISH_QUEUE]));
        expect(queues.every((q) => typeof q === 'string')).toBe(true);

        const ch = channel();
        const init = new RabbitMQDLQInitializer({ channel: ch, managedChannel: { addSetup: jest.fn() } } as any);
        await init.onApplicationBootstrap();
        const delayed = ch.binds.filter(([, ex]) => ex === 'workflow.exchange.delayed');
        const bindingOf: Record<string, string> = {
            [runMessages.RUNTIME_TRIGGER_QUEUE]: runMessages.RUNTIME_TRIGGER_BINDING,
            [runMessages.RUNTIME_PUBLISH_QUEUE]: runMessages.RUNTIME_PUBLISH_BINDING,
        };
        for (const q of queues as string[]) {
            expect(delayed).toContainEqual([q, 'workflow.exchange.delayed', bindingOf[q]]);
        }
    });
});
