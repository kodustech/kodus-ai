import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { PgHostPoolReader } from '../shared/persistence/host-pools';
import { isolatedDatabase } from '../testing/isolated-database';
import { PgFleetStore } from './fleet-store';
import { PgPoolSpecWriter, PoolApplyRefused, resolvePoolDocuments } from './pool-apply';

// Opt-in: RUNTIME_IT_DATABASE_URL. `runtime-fleet apply` against the Runtime tables (docs/runtime/host-providers.md
// §5.2): what it writes is what the fleet drives and what placement offers; it never touches status or hosts.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'pool_apply');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';

const boat = (over: { weight?: number; provider?: 'boat' | 'fake' } = {}) => {
    const provider = over.provider ?? 'boat';
    const r = resolvePoolDocuments(
        [
            {
                source: 'pools.yaml#1',
                doc: {
                    kind: 'HostPool',
                    name: 'boat-eu-perrun',
                    scope: 'kodus',
                    provider,
                    lifecycle: 'perRun',
                    weight: over.weight ?? 100,
                    admission: { allowOrgs: ['org-kodus'] },
                    hostClass: provider === 'boat' ? { kind: 'HostClass', name: 'boat-large-cell', provider: 'boat', boat: { type: 'large', base: 'kodus-cell-r42-gvisor' } } : { kind: 'HostClass', name: 'fake', provider: 'fake' },
                },
            },
        ],
        { allowFake: true },
    );
    if (r.ok === false) throw new Error(r.errors.join('\n'));
    return r.pools;
};

(skip ? describe.skip : describe)('runtime-fleet apply (real Postgres)', () => {
    let pool: Pool;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: database.url, max: 3 });
        await ensureRuntimeSchema(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    it('an applied boat pool is one the fleet drives and placement offers to the orgs it admits; applied again it changes the spec and keeps what the fleet wrote', async () => {
        const writer = new PgPoolSpecWriter(pool);
        expect(await writer.apply(boat())).toEqual([{ poolId: 'boat-eu-perrun', action: 'created', specHash: boat()[0].specHash }]);
        const fleet = new PgFleetStore(pool);
        const driven = await fleet.controlledPools();
        expect(driven.invalid).toEqual([]);
        expect(driven.pools.map((p) => [p.poolId, p.pool.hostClass.provider === 'boat' && p.pool.hostClass.boat.base])).toEqual([['boat-eu-perrun', 'kodus-cell-r42-gvisor']]);
        const offered = (await new PgHostPoolReader(pool, { cacheMs: 0 }).list()).find((p) => p.poolId === 'boat-eu-perrun');
        expect(offered).toMatchObject({ provider: 'boat', lifecycle: 'perRun', weight: 100, allowOrgs: ['org-kodus'], scalable: false });

        await fleet.setPoolStatus('boat-eu-perrun', { scalable: true });
        expect(await writer.apply(boat({ weight: 50 }))).toEqual([expect.objectContaining({ action: 'updated' })]);
        expect(await writer.apply(boat({ weight: 50 }))).toEqual([expect.objectContaining({ action: 'unchanged' })]);
        const after = (await new PgHostPoolReader(pool, { cacheMs: 0 }).list()).find((p) => p.poolId === 'boat-eu-perrun');
        expect(after).toMatchObject({ weight: 50, scalable: true });
    });

    it("a pool cannot change provider under its name, and a refused apply writes none of the file's pools", async () => {
        const writer = new PgPoolSpecWriter(pool);
        const other = resolvePoolDocuments([{ source: 'b', doc: { kind: 'HostPool', name: 'second-pool', scope: 'kodus', provider: 'fake', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'fake', provider: 'fake' } } }], { allowFake: true });
        if (!other.ok) throw new Error('second pool');
        await expect(writer.apply([...other.pools, ...boat({ provider: 'fake' })])).rejects.toThrow(PoolApplyRefused);
        const rows = (await pool.query(`SELECT pool_id, provider FROM runtime.runtime_host_pools WHERE pool_id IN ('boat-eu-perrun', 'second-pool') ORDER BY pool_id`)).rows;
        expect(rows).toEqual([{ pool_id: 'boat-eu-perrun', provider: 'boat' }]);
    });
});
