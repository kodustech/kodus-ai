/**
 * Child process for distributed-lock.service.integration.spec.ts: takes and
 * releases a lock, closes its database, and then has nothing left to do. It
 * must exit on its own; a renewal thread that kept it alive would hold up
 * every container stop until SIGKILL.
 */
import { DataSource } from 'typeorm';

import { DistributedLockService } from '../distributed-lock.service';

async function main(): Promise<void> {
    const dataSource = new DataSource({
        type: 'postgres',
        host: process.env.LOCK_IT_HOST,
        port: Number(process.env.LOCK_IT_PORT),
        username: process.env.LOCK_IT_USER,
        password: process.env.LOCK_IT_PASSWORD,
        database: process.env.LOCK_IT_DB,
        entities: [],
        extra: { max: 1 },
    });
    await dataSource.initialize();
    const service = new DistributedLockService(dataSource);
    const lock = await service.acquire(`exiting-holder::${process.pid}`);
    await lock?.release();
    await dataSource.destroy();
    // No explicit exit and no ThreadLeaseRenewer.stopAll(): the process
    // ends when nothing but the renewal thread is left.
}

void main();
