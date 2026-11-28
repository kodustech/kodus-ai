import { randomUUID } from 'crypto';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { CreateRuntimePushSetups2026112600000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026112600000000-CreateRuntimePushSetups';

import { TypeOrmPushSetupLedger } from '../infrastructure/typeorm-push-setups.store';
import { TypeOrmSql } from '../infrastructure/typeorm-sql';

// The push setup ledger against a real Postgres: what only the database guarantees, one claim of a pending commit and
// one pass of the daily limit among replicas racing. Opt-in: RUNTIME_IT_DATABASE_URL (a throwaway schema).
const pgUrl = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !pgUrl || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('Runtime push setups (integration, real Postgres)', () => {
    const schema = `it_runtime_push_setups_${process.pid}_${Date.now()}`;
    const DAY = new Date('2026-11-26T12:00:00.000Z');
    let admin: Pool;
    const sources: DataSource[] = [];

    const replica = async () => {
        const source = new DataSource({ type: 'postgres', url: pgUrl, entities: [], synchronize: false, extra: { options: `-c search_path=${schema}`, max: 10 } });
        await source.initialize();
        sources.push(source);
        return new TypeOrmPushSetupLedger(new TypeOrmSql(source));
    };
    const key = () => ({ organizationId: `org-${randomUUID()}`, environmentId: 'env-1' });

    beforeAll(async () => {
        admin = new Pool({ connectionString: pgUrl, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await replica();
        const runner = sources[0].createQueryRunner();
        try {
            await new CreateRuntimePushSetups2026112600000000().up(runner);
        } finally {
            await runner.release();
        }
    });

    afterAll(async () => {
        for (const s of sources) await s.destroy();
        if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
        }
    });

    it('of many replicas claiming one pending commit at once, exactly one gets it', async () => {
        const ledgers = [await replica(), await replica()];
        const k = key();
        await ledgers[0].markPending(k, 'a'.repeat(40), DAY);
        const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => ledgers[i % 2].claim(k, DAY, 12)));
        expect(claims.filter((c) => c.status === 'claimed')).toHaveLength(1);
        expect(claims.filter((c) => c.status === 'none')).toHaveLength(19);
    });

    it('a later push replaces the pending commit', async () => {
        const [ledger] = [await replica()];
        const k = key();
        await ledger.markPending(k, 'a'.repeat(40), DAY);
        await ledger.markPending(k, 'b'.repeat(40), DAY);
        expect(await ledger.claim(k, DAY, 12)).toEqual({ status: 'claimed', sha: 'b'.repeat(40), spentToday: 1 });
    });

    it('stops after the daily limit, drops the commit it refused, and starts again the next UTC day', async () => {
        const ledger = await replica();
        const k = key();
        const results: string[] = [];
        for (let i = 0; i < 3; i++) {
            await ledger.markPending(k, String(i).repeat(40), DAY);
            results.push((await ledger.claim(k, DAY, 2)).status);
        }
        expect(results).toEqual(['claimed', 'claimed', 'budget_spent']);
        expect((await ledger.listPending(1000)).filter((p) => p.organizationId === k.organizationId)).toEqual([]);
        await ledger.markPending(k, 'f'.repeat(40), new Date(DAY.getTime() + 24 * 3_600_000));
        expect(await ledger.claim(k, new Date(DAY.getTime() + 24 * 3_600_000), 2)).toMatchObject({ status: 'claimed', spentToday: 1 });
    });

    it('a restored commit comes back with its place in the count, and never overwrites a newer one', async () => {
        const ledger = await replica();
        const k = key();
        await ledger.markPending(k, 'a'.repeat(40), DAY);
        await ledger.claim(k, DAY, 12);
        await ledger.markPending(k, 'b'.repeat(40), DAY);
        await ledger.restorePending(k, 'a'.repeat(40), DAY);
        expect(await ledger.claim(k, DAY, 12)).toEqual({ status: 'claimed', sha: 'b'.repeat(40), spentToday: 1 });
    });

    it('lists the pending environments, oldest first, and clears only the commit it is told to', async () => {
        const ledger = await replica();
        const [first, second] = [key(), key()];
        await ledger.markPending(first, 'a'.repeat(40), new Date(DAY.getTime() - 1000));
        await ledger.markPending(second, 'b'.repeat(40), DAY);
        const mine = (await ledger.listPending(1000)).filter((p) => [first.organizationId, second.organizationId].includes(p.organizationId));
        expect(mine.map((p) => p.organizationId)).toEqual([first.organizationId, second.organizationId]);
        await ledger.clearPending(first, 'c'.repeat(40));
        await ledger.clearPending(second, 'b'.repeat(40));
        const left = (await ledger.listPending(1000)).filter((p) => [first.organizationId, second.organizationId].includes(p.organizationId));
        expect(left.map((p) => p.organizationId)).toEqual([first.organizationId]);
    });
});
