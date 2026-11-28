import { Pool } from 'pg';

import { FakeHostProvider } from '@libs/runtime/fleet/fake-provider';
import { parseHostPool } from '@libs/runtime/fleet/pool';
import { boundKeyOfRunSide, candidatePools } from '@libs/runtime/placement/candidate-pools';

import { recordPoolDemand } from '../shared/persistence/cell-directory';
import { poolViewOf } from '../shared/persistence/host-pools';
import { ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../testing/isolated-database';
import { PgFleetStore } from './fleet-store';
import { reconcileOnce } from './reconcile';

// Opt-in: RUNTIME_IT_DATABASE_URL. A Run whose pair does not fit one host: placement gives each side its own key, the
// directory records one demand row per side, and the fleet starts one host per side (docs/runtime/host-providers.md §6.2).
const runtimeDb = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'fleet_run_sides');
const skip = !runtimeDb.url || process.env.SKIP_INTEGRATION === 'true';

const POOL = parseHostPool({
    kind: 'HostPool',
    name: 'fake-perrun',
    scope: 'kodus',
    provider: 'fake',
    lifecycle: 'perRun',
    hostClass: { kind: 'HostClass', name: 'fake', provider: 'fake' },
    perRun: { registrationTimeoutSeconds: 60, maxRunMinutes: 30 },
});

(skip ? describe.skip : describe)('a Run whose sides do not fit one host (real Postgres)', () => {
    let pool: Pool;
    let store: PgFleetStore;
    const provider = new FakeHostProvider({ installation: 'it', startState: 'running' });

    beforeAll(async () => {
        await runtimeDb.create();
        pool = new Pool({ connectionString: runtimeDb.url, max: 4 });
        await ensureRuntimeSchema(pool);
        await pool.query(`INSERT INTO runtime.runtime_host_pools (pool_id, scope, provider, lifecycle, spec) VALUES ('fake-perrun', 'kodus', 'fake', 'perRun', $1)`, [JSON.stringify(POOL)]);
        store = new PgFleetStore(pool);
    }, 60_000);

    afterAll(async () => {
        await pool?.end();
        await runtimeDb.drop();
    });

    // Behavior: one reconcile pass records the host class the provider reports, and placement reads it back from the pool row.
    it('the fleet writes the pool host class and placement splits an 8192 MB pair on it, one key per side', async () => {
        const started: string[] = [];
        await reconcileOnce({ store, start: async (i) => void started.push(i.boundKey), providerFor: (k) => (k === 'fake' ? provider : undefined), installation: 'it', now: Date.now, log: () => undefined });
        const row = (await pool.query(`SELECT * FROM runtime.runtime_host_pools WHERE pool_id='fake-perrun'`)).rows[0];
        const view = poolViewOf(row);
        expect(view.hostClass).toEqual({ memoryMb: 16_384, cpus: 8 });
        const ask = { organizationId: 'org-a', consumer: 'runtime', runId: 'run-1', sideSize: { memoryMb: 8192, cpus: 4 } };
        expect(candidatePools([view], { ...ask, side: 'base' })?.boundKey).toBe('run:org-a/run-1/base');
        expect(candidatePools([view], { ...ask, side: 'pr' })?.boundKey).toBe('run:org-a/run-1/pr');
    });

    // Behavior: demand for both sides makes the fleet start two hosts, each bound to its side's key, and the rows carry the Run.
    it('demand for each side starts one host per side, each bound to its own key', async () => {
        for (const side of ['base', 'pr'] as const) {
            const boundKey = boundKeyOfRunSide('org-a', 'run-2', side);
            await recordPoolDemand(pool, { poolId: 'fake-perrun', boundKey, organizationId: 'org-a', runId: 'run-2', sizeMb: 8192 });
        }
        const started: Array<{ hostId: string; boundKey: string }> = [];
        await reconcileOnce({ store, start: async (i) => void started.push({ hostId: i.hostId, boundKey: i.boundKey }), providerFor: (k) => (k === 'fake' ? provider : undefined), installation: 'it', now: Date.now, log: () => undefined });
        expect(started.map((s) => s.boundKey).sort()).toEqual(['run:org-a/run-2/base', 'run:org-a/run-2/pr']);
        expect(new Set(started.map((s) => s.hostId)).size).toBe(2);
    });

    // Behavior: when the Run ends, the demand of both sides lapses, so neither host is asked for again.
    it('both sides demand rows lapse together when their expiry passes', async () => {
        await pool.query(`UPDATE runtime.runtime_pool_demand SET expires_at = now() - interval '1 second' WHERE run_id='run-2'`);
        const open = await store.openDemand('fake-perrun');
        expect(open.filter((d) => d.runId === 'run-2')).toEqual([]);
    });
});
