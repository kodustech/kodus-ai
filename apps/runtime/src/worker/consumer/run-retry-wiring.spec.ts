import { LOCK_SCOPED_PG } from '../../shared/persistence/lock-scoped-pg';
import { PR_ADMISSION_STORE } from '../../shared/admission/pr-admission-store';
import { RUNTIME_PG_POOL, COMMAND_STORE } from '../../shared/config';
import { ADMISSION_COORDINATOR } from '../dbos/admission-coordinator';
import { InMemoryPrAdmissionStore } from '../../shared/admission/pr-admission-store';
import {
    AmqpConnection,
    Nack,
    RABBIT_HANDLER,
} from '@golevelup/nestjs-rabbitmq';

import { RuntimeEventName } from '@libs/runtime/run/run-messages';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';

import { loadWorkerConfig } from '../../shared/config';
import { InMemoryCommandStore } from '../../shared/persistence/pg-command-store';
import { DEV_SECRET_SEAL_KEY_HEX } from '../../testing/dev-seal-key';
import { shopRunRequest } from '../../e2e/fixtures';
import { RuntimeCommandConsumer } from './run-request.consumer';
import { RuntimeWorkerModule } from '../runtime-worker.module';
import { RuntimeRunRetry, runtimeRunErrorHandler } from './runtime-run-retry';

describe('Runtime Run retry contract', () => {
    it('requires a production PG fence and shares the explicit lock-scoped adapter', () => {
        const config = loadWorkerConfig({
            RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
        });
        const providers = RuntimeWorkerModule.forConfig(config)
            .providers as any[];
        const provider = (token: unknown) =>
            providers.find((p) => p.provide === token);
        expect(provider(PR_ADMISSION_STORE).inject).toEqual([
            RUNTIME_PG_POOL,
            LOCK_SCOPED_PG,
        ]);
        expect(provider(COMMAND_STORE).inject).toEqual([
            RUNTIME_PG_POOL,
            LOCK_SCOPED_PG,
        ]);
        expect(provider(ADMISSION_COORDINATOR).inject).toContain(
            LOCK_SCOPED_PG,
        );
        expect(
            providers.filter((p) => p.provide === LOCK_SCOPED_PG),
        ).toHaveLength(1);
        expect(
            Reflect.getMetadata('optional:paramtypes', RuntimeCommandConsumer),
        ).not.toContain(3);
    });

    it('registers a retry callback but cannot bind its publish-only exchange', () => {
        const run = Reflect.getMetadata(
            RABBIT_HANDLER,
            RuntimeCommandConsumer.prototype.onMessage,
        );
        const control = Reflect.getMetadata(
            RABBIT_HANDLER,
            RuntimeCommandConsumer.prototype.onControl,
        );
        expect(run.errorHandler).toEqual(expect.any(Function));
        expect(run.deserializer).toEqual(expect.any(Function));
        expect(run.bindings).toBeUndefined();
        expect(control.bindings).toBeUndefined();
    });

    it('loads bounded standalone retry settings without importing product configuration', () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        expect(loadWorkerConfig(base)).toMatchObject({
            brokerRetry: { maxRetries: 5, delayMs: 1000, maxDelayMs: 30000 },
        });
        expect(
            loadWorkerConfig({
                ...base,
                WORKFLOW_QUEUE_WORKER_MAX_RETRIES: '2',
                WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS: '250',
            }),
        ).toMatchObject({ brokerRetry: { maxRetries: 2, delayMs: 250 } });
        expect(
            loadWorkerConfig({
                ...base,
                RUNTIME_COMMAND_MAX_RETRIES: '0',
                RUNTIME_COMMAND_RETRY_DELAY_MS: '500',
            }),
        ).toMatchObject({ brokerRetry: { maxRetries: 0, delayMs: 500 } });
        expect(
            loadWorkerConfig({
                ...base,
                RUNTIME_COMMAND_RETRY_DELAY_MS: '60000',
            }),
        ).toMatchObject({ brokerRetry: { delayMs: 60000, maxDelayMs: 60000 } });
        for (const value of ['-1', '1.5', '11', 'not-a-number']) {
            expect(() =>
                loadWorkerConfig({
                    ...base,
                    RUNTIME_COMMAND_MAX_RETRIES: value,
                }),
            ).toThrow(/RUNTIME_COMMAND_MAX_RETRIES/);
        }
        for (const value of ['0', '-1', '60001', 'not-a-number']) {
            expect(() =>
                loadWorkerConfig({
                    ...base,
                    RUNTIME_COMMAND_RETRY_DELAY_MS: value,
                }),
            ).toThrow(/RUNTIME_COMMAND_RETRY_DELAY_MS/);
        }
        try {
            loadWorkerConfig({
                ...base,
                RUNTIME_COMMAND_MAX_RETRIES: 'SECRET',
            });
        } catch (error) {
            expect((error as Error).message).not.toContain('SECRET');
        }
    });

    it('wires an independent retry provider from the validated worker policy', async () => {
        const config = loadWorkerConfig({
            RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
            RUNTIME_COMMAND_MAX_RETRIES: '0',
        });
        const module = RuntimeWorkerModule.forConfig(config);
        const provider = (module.providers as any[]).find(
            (p) => p.provide === RuntimeRunRetry,
        );
        expect(provider.inject).toEqual([AmqpConnection]);
        const amqp = { publish: jest.fn() };
        const retry = provider.useFactory(amqp);
        const channel = { ack: jest.fn(), nack: jest.fn() };
        const message = {
            properties: { headers: {} },
            fields: { routingKey: 'workflow.jobs.created.RUNTIME_RUN' },
        } as any;
        await runtimeRunErrorHandler(channel as any, message, retry.failure());
        expect(channel.nack).toHaveBeenCalledWith(message, false, false);
        expect(amqp.publish).not.toHaveBeenCalled();
    });

    it('dead-letters non-string events without logging or throwing their contents', async () => {
        const engine = {
            start: jest.fn(),
            stop: jest.fn(),
            approve: jest.fn(),
        };
        const consumer = new RuntimeCommandConsumer(
            engine as any,
            new InMemoryRunProjectionStore(),
            new InMemoryCommandStore(),
            new InMemoryPrAdmissionStore(),
        );
        const result = await consumer.handle({
            event_name: { secret: 'not-loggable' },
            payload: {},
        } as any);
        expect(result).toBeInstanceOf(Nack);
        expect((result as Nack).requeue).toBe(false);
        expect(engine.start).not.toHaveBeenCalled();
    });

    it.each([null, undefined, 1, true, []])(
        'does not turn explicit non-string event %p into a default Run',
        async (event) => {
            const engine = {
                start: jest.fn(),
                stop: jest.fn(),
                approve: jest.fn(),
            };
            const consumer = new RuntimeCommandConsumer(
                engine as any,
                new InMemoryRunProjectionStore(),
                new InMemoryCommandStore(),
                new InMemoryPrAdmissionStore(),
            );
            expect(
                await consumer.handle({
                    event_name: event,
                    payload: shopRunRequest(),
                }),
            ).toBeInstanceOf(Nack);
            expect(engine.start).not.toHaveBeenCalled();
        },
    );

    it('refuses control commands on the Run lane and Run commands on the control lane', async () => {
        const commands = new InMemoryCommandStore();
        const engine = {
            start: jest.fn(),
            stop: jest.fn(),
            approve: jest.fn(),
        };
        const consumer = new RuntimeCommandConsumer(
            engine as any,
            new InMemoryRunProjectionStore(),
            commands,
            new InMemoryPrAdmissionStore(),
        );
        const control = {
            event_name: RuntimeCommandName.StopRequested,
            payload: {
                scope: 'global',
                requestedBy: { userId: 'a' },
                requestedAt: new Date().toISOString(),
                correlationId: 'c',
            },
        };
        expect(await consumer.onMessage(control)).toBeInstanceOf(Nack);
        expect(commands.stops).toEqual([]);
        expect(
            await consumer.onControl({
                event_name: RuntimeEventName.RunRequested,
                payload: {},
            }),
        ).toBeInstanceOf(Nack);
    });
});
