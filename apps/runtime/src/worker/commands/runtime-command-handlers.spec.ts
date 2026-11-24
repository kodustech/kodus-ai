import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { loadWorkerConfig, RUNTIME_PG_POOL } from '../../shared/config';
import { PgDistributedLocks } from '../../shared/persistence/locks';
import { DEV_SECRET_SEAL_KEY_HEX } from '../../testing/dev-seal-key';
import { RuntimeCommandConsumer } from '../consumer/run-request.consumer';
import { RuntimeRunRetry } from '../consumer/runtime-run-retry';
import { RUN_ENGINE_LOCKS } from '../dbos/run-engine.service';
import { RUNTIME_LOCK_PG_POOL, RuntimeWorkerModule } from '../runtime-worker.module';
import { RunEngineService } from '../dbos/run-engine.service';
import { CONSUMER_LOCKS, RUNTIME_COMMAND_HANDLERS, runtimeCommandHandlersProvider } from './runtime-command-handlers';

/** The worker module's own providers for these tokens, as production wires them. */
function productionProviders(...tokens: unknown[]): Provider[] {
    const providers = RuntimeWorkerModule.forConfig(loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX })).providers as Provider[];
    return tokens.map((token) => {
        const found = providers.find((p) => (typeof p === 'function' ? p === token : p.provide === token));
        if (!found) throw new Error(`the worker module provides no ${String(token)}`);
        return found;
    });
}

/** Every leaf the handlers inject, as a stand-in, except the ones named. */
function leavesWithout(...missing: unknown[]): Provider[] {
    const leaves = runtimeCommandHandlersProvider.inject!.filter((token) => token !== CONSUMER_LOCKS && !missing.includes(token));
    return [
        ...leaves.map((token) => ({ provide: token as symbol, useValue: { setup: {} } })),
        { provide: AmqpConnection, useValue: { publish: jest.fn() } },
        { provide: RUNTIME_PG_POOL, useValue: { connect: jest.fn(), query: jest.fn() } },
        { provide: RUNTIME_LOCK_PG_POOL, useValue: { connect: jest.fn(), query: jest.fn() } },
    ];
}

const consumerGraph = () => productionProviders(RUN_ENGINE_LOCKS, CONSUMER_LOCKS, RUNTIME_COMMAND_HANDLERS, RuntimeRunRetry, RuntimeCommandConsumer);

describe('Runtime command consumer wiring', () => {
    it('boots with the PR lock on the Postgres advisory locks the engine uses', async () => {
        const module = await Test.createTestingModule({ providers: [...consumerGraph(), ...leavesWithout()] }).compile();
        const locks = module.get(CONSUMER_LOCKS);
        expect(locks).toBeInstanceOf(PgDistributedLocks);
        expect(locks).toBe(module.get(RUN_ENGINE_LOCKS));
        expect(module.get(RuntimeCommandConsumer)).toBeInstanceOf(RuntimeCommandConsumer);
    });

    it('fails to boot when the module loses the PR lock provider, instead of locking in one process', async () => {
        const withoutLocks = consumerGraph().filter((p) => typeof p === 'function' || p.provide !== CONSUMER_LOCKS);
        await expect(Test.createTestingModule({ providers: [...withoutLocks, ...leavesWithout()] }).compile()).rejects.toThrow(/CONSUMER_LOCKS/);
    });

    it.each(runtimeCommandHandlersProvider.inject!.filter((token) => token !== CONSUMER_LOCKS).map((token) => [String((token as symbol).description ?? (token as { name?: string }).name), token]))(
        'fails to boot when the module loses %s, instead of disabling its handler',
        async (_name, token) => {
            await expect(Test.createTestingModule({ providers: [...consumerGraph(), ...leavesWithout(token)] }).compile()).rejects.toThrow(/can't resolve dependencies/i);
        },
    );

    it('registers the suite handlers in production: a request and a retry, both enqueued through the engine', async () => {
        const started: unknown[] = [];
        const engine = { startSuite: async (c: unknown) => (started.push(c), 'wf') };
        const module = await Test.createTestingModule({ providers: [...consumerGraph(), ...leavesWithout(RunEngineService), { provide: RunEngineService, useValue: engine }] }).compile();
        const handlers = module.get<Array<{ event: string; handle(b: Record<string, unknown>): Promise<unknown> }>>(RUNTIME_COMMAND_HANDLERS);
        const request = handlers.find((h) => h.event === 'runtime.suite.requested')!;
        expect(handlers.some((h) => h.event === 'runtime.suite.retried')).toBe(true);
        expect(await request.handle({ suiteRunId: '0b8e3c2a-6d1f-4a57-9c3e-1f2a3b4c5d6e', organizationId: 'o', environmentId: 'e', repositoryId: 'r', mode: 'baseline', mainSha: 'a'.repeat(40), requestedAt: '2026-11-23T12:00:00.000Z', key: 'k' })).toBeUndefined();
        expect(started).toHaveLength(1);
    });

    it('fails to boot without the broker retry, instead of dead-lettering every failed dispatch', async () => {
        const withoutRetry = consumerGraph().filter((p) => typeof p === 'function' ? p !== RuntimeRunRetry : p.provide !== RuntimeRunRetry);
        await expect(Test.createTestingModule({ providers: [...withoutRetry, ...leavesWithout()] }).compile()).rejects.toThrow(/RuntimeRunRetry/);
    });
});
