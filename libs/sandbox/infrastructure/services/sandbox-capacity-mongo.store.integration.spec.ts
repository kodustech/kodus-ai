import mongoose, { Connection } from 'mongoose';

import { resolveMongoTestGate } from '../../../../test/integration/mongo-test-uri';
import {
    SandboxCapacityStateSchema,
    SandboxCapacityTicketSchema,
} from '../repositories/schemas/sandbox-capacity.model';
import { SandboxCapacityGate } from './sandbox-capacity-gate';
import { MongoCapacityStore } from './sandbox-capacity-mongo.store';

// Runs in CI (TEST_MONGODB_URI); skips locally without it.
const gate = resolveMongoTestGate('kodus_test', false);

(gate.shouldSkip ? describe.skip : describe)(
    'MongoCapacityStore (integration)',
    () => {
        let connection: Connection;
        let store: MongoCapacityStore;

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    dbName: 'kodus_sandbox_capacity_it',
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
            await connection.dropDatabase();
            store = new MongoCapacityStore(
                connection.model('T', SandboxCapacityTicketSchema),
                connection.model('S', SandboxCapacityStateSchema),
            );
        }, 30_000);

        afterAll(async () => {
            await connection?.dropDatabase();
            await connection?.close();
        });

        it('never admits more than the cap when many workers race, and reaps a dead slot', async () => {
            const cap = 3;
            const now = new Date();
            const dead = new Date(now.getTime() - 45_000);
            const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
            for (const id of ids)
                await store.enqueue({ id, prKey: 'k', workerId: 'w' }, now);

            const results = await Promise.all(
                ids.map((id) => store.tryAdmit(id, cap, now, dead)),
            );
            expect(results.filter(Boolean)).toHaveLength(cap);
            expect((await store.numbers(dead)).inUse).toBe(cap);

            // Their heartbeat goes stale (a crashed worker): the slots free up
            const later = new Date(now.getTime() + 60_000);
            await store.enqueue({ id: 'next', prKey: 'k', workerId: 'w' }, later);
            expect(await store.tryAdmit('next', cap, later, new Date(later.getTime() - 45_000))).toBe(true);
            expect((await store.numbers(new Date(later.getTime() - 45_000))).inUse).toBe(1);
        });

        it('serves FIFO through the gate', async () => {
            await connection.dropDatabase();
            const g = new SandboxCapacityGate(
                store,
                () => ({ maxConcurrent: 1, maxWaitMs: 30_000 }),
                Date.now,
                (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
            );
            const first: any = await g.acquire('a', 'k:1');
            const order: string[] = [];
            const waits: Promise<void>[] = [];
            for (const id of ['b', 'c', 'd']) {
                waits.push(
                    g.acquire(id, `k:${id}`).then(async (x: any) => {
                        order.push(id);
                        await x.release();
                    }),
                );
                await new Promise((r) => setTimeout(r, 15));
            }
            await first.release();
            await Promise.all(waits);
            expect(order).toEqual(['b', 'c', 'd']);
        });
    },
);
