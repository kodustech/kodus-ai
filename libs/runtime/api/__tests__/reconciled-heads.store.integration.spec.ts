import { randomUUID } from 'crypto';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { CreateRuntimeReconciledHeads2026111500000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111500000000-CreateRuntimeReconciledHeads';

import { RECONCILE_MAX_ATTEMPTS, type ReconciledHeadKey } from '../domain/webhook-reconciler';
import { TypeOrmReconciledHeadStore } from '../infrastructure/typeorm-reconciled-heads.store';
import { TypeOrmSql } from '../infrastructure/typeorm-sql';

// The reconciler's ledger against a real Postgres: what only the database
// guarantees, one claim of a head among replicas racing on it. Opt-in:
// RUNTIME_IT_DATABASE_URL (a throwaway schema). Synthetic ids only.
const pgUrl = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !pgUrl || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('Runtime reconciled heads (integration, real Postgres)', () => {
    const schema = `it_runtime_reconciled_${process.pid}_${Date.now()}`;
    let admin: Pool;
    const sources: DataSource[] = [];

    /** One product-worker replica's own connection pool. */
    const replica = async () => {
        const source = new DataSource({ type: 'postgres', url: pgUrl, entities: [], synchronize: false, extra: { options: `-c search_path=${schema}`, max: 10 } });
        await source.initialize();
        sources.push(source);
        return new TypeOrmSql(source);
    };
    const key = (): ReconciledHeadKey => ({ organizationId: `org-${randomUUID()}`, repositoryId: 'repo-1', prNumber: 7, headSha: 'a'.repeat(40) });

    beforeAll(async () => {
        admin = new Pool({ connectionString: pgUrl, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        const sql = await replica();
        const runner = sources[0].createQueryRunner();
        try {
            await new CreateRuntimeReconciledHeads2026111500000000().up(runner);
        } finally {
            await runner.release();
        }
        void sql;
    });

    afterAll(async () => {
        for (const s of sources) await s.destroy();
        if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
        }
    });

    it('of many replicas claiming one head at once, exactly one gets it', async () => {
        const stores = [new TypeOrmReconciledHeadStore(await replica()), new TypeOrmReconciledHeadStore(await replica())];
        const head = key();
        const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].claim(head)));
        expect(claims.filter((c) => c !== null)).toEqual([1]);
    });

    it('a decided head is never claimed again; a failed one is, up to the attempt limit', async () => {
        const store = new TypeOrmReconciledHeadStore(sources[0] ? new TypeOrmSql(sources[0]) : await replica());
        const decided = key();
        const first = await store.claim(decided);
        await store.settle(decided, first!, 'enqueued');
        expect(await store.claim(decided)).toBeNull();

        const failing = key();
        const attempts: Array<number | null> = [];
        for (let i = 0; i < RECONCILE_MAX_ATTEMPTS + 1; i++) {
            const attempt = await store.claim(failing);
            attempts.push(attempt);
            if (attempt !== null) await store.fail(failing, attempt, 'Error');
        }
        expect(attempts).toEqual([1, 2, 3, null]);
    });

    it('a live claim is not taken over; a stale one is, and the old holder can no longer settle it', async () => {
        const sql = await replica();
        const store = new TypeOrmReconciledHeadStore(sql);
        const head = key();
        expect(await store.claim(head)).toBe(1);
        expect(await store.claim(head)).toBeNull();
        // The holder died: its claim is older than the stale bound.
        await sql.query(`UPDATE runtime_reconciled_heads SET claimed_at = now() - interval '1 hour' WHERE organization_id = $1`, [head.organizationId]);
        expect(await store.claim(head)).toBe(2);
        await store.settle(head, 1, 'enqueued');
        const { rows } = await sql.query(`SELECT state, attempts, outcome FROM runtime_reconciled_heads WHERE organization_id = $1`, [head.organizationId]);
        expect(rows).toEqual([{ state: 'claimed', attempts: 2, outcome: null }]);
        await store.settle(head, 2, 'skipped:rule_not_matched');
        expect((await sql.query(`SELECT state, outcome FROM runtime_reconciled_heads WHERE organization_id = $1`, [head.organizationId])).rows).toEqual([
            { state: 'decided', outcome: 'skipped:rule_not_matched' },
        ]);
    });
});
