/**
 * Child process for distributed-lock.service.integration.spec.ts: a lock
 * holder whose event loop gets blocked, the way a CPU-bound review step
 * blocks a worker. Talks to the parent over IPC:
 *   parent → { key, blockMs }   child → 'acquired' → (blocked) → result
 */
import { DataSource } from 'typeorm';

import { DistributedLockService } from '../distributed-lock.service';
import { ThreadLeaseRenewer } from '../lease-renewer';

const send = (message: unknown) =>
    new Promise<void>((resolve) => process.send!(message, () => resolve()));

async function main(): Promise<void> {
    const { key, blockMs, leaseMs } = await new Promise<{
        key: string;
        blockMs: number;
        leaseMs: number;
    }>((resolve) => process.once('message', resolve as any));

    const dataSource = new DataSource({
        type: 'postgres',
        host: process.env.LOCK_IT_HOST,
        port: Number(process.env.LOCK_IT_PORT),
        username: process.env.LOCK_IT_USER,
        password: process.env.LOCK_IT_PASSWORD,
        database: process.env.LOCK_IT_DB,
        entities: [],
        extra: { max: 2 },
    });
    await dataSource.initialize();
    const service = new DistributedLockService(dataSource, undefined, {
        leaseMs,
        mode: 'lease',
    });

    const lock = await service.acquire(key);
    await send({ acquired: lock !== null });

    const until = Date.now() + blockMs;
    while (Date.now() < until) {
        // busy: no timer on this thread can run
    }
    // Let a renewal that was due during the block land before reporting.
    await new Promise((resolve) => setTimeout(resolve, 500));

    await send({ lost: lock?.isLost() ?? null });
    await lock?.release().catch(() => undefined);
    service.onModuleDestroy();
    await service.onApplicationShutdown();
    await ThreadLeaseRenewer.stopAll();
    await dataSource.destroy();
}

main().catch(async (error) => {
    await send({ error: String(error?.stack ?? error) });
    process.exit(1);
});
