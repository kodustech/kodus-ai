import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';

import { FakeHostProvider } from '@libs/runtime/fleet/fake-provider';
import { parseHostPool } from '@libs/runtime/fleet/pool';

import { ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { devSealKey } from '../testing/dev-seal-key';
import { isolatedDatabase } from '../testing/isolated-database';
import { FleetEngine, perRunWorkflowId } from './fleet-engine';
import { fleetHostId, PgFleetStore } from './fleet-store';
import { reconcileOnce } from './reconcile';
import { FakeHubFleet, FixedTemplates } from './testing';

// Opt-in: RUNTIME_IT_DATABASE_URL. The perRun lifecycle on the fleet's own DBOS application and the Runtime
// tables (docs/runtime/host-providers.md §7.0), with the fake provider: demand → one host → ready → served → gone.
const runtimeDb = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'fleet_runtime');
const systemDb = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'fleet_dbos');
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

const until = async (what: string, fn: () => Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
    }
};

(skip ? describe.skip : describe)('runtime-fleet perRun hosts on DBOS (real Postgres)', () => {
    let pool: Pool;
    let store: PgFleetStore;
    let engine: FleetEngine;
    const provider = new FakeHostProvider({ installation: 'it', startState: 'running' });
    const hub = new FakeHubFleet();

    beforeAll(async () => {
        await runtimeDb.create();
        await systemDb.create();
        pool = new Pool({ connectionString: runtimeDb.url, max: 6 });
        await ensureRuntimeSchema(pool);
        await pool.query(`INSERT INTO runtime.runtime_host_pools (pool_id, scope, provider, lifecycle, spec) VALUES ('fake-perrun', 'kodus', 'fake', 'perRun', $1)`, [JSON.stringify(POOL)]);
        store = new PgFleetStore(pool);
        engine = new FleetEngine(
            { systemDatabaseUrl: systemDb.url, releaseVersion: `it-${Date.now()}`, dbosLogLevel: 'error' },
            {
                store,
                hub,
                providerFor: (k) => (k === 'fake' ? provider : undefined),
                templates: new FixedTemplates(null),
                installation: 'it',
                bootstrap: { hubUrl: 'https://hub.example:3410', hubCa: 'CA' },
                sealKey: devSealKey(),
                timing: { pollMs: 100, serveCheckMs: 100, extendEveryMs: 300, createAttempts: 3 },
            },
        );
        await engine.launch();
    }, 60_000);

    afterAll(async () => {
        await engine?.shutdown();
        await pool?.end();
        await runtimeDb.drop();
        await systemDb.drop();
    });

    it('a Run that asks for room gets one host, its cell serves it, and the host is destroyed once the Run is done', async () => {
        const boundKey = 'run:org-a/r-1';
        const hostId = fleetHostId('fake-perrun', boundKey);
        await pool.query(`INSERT INTO runtime.runtime_pool_demand (pool_id, bound_key, organization_id, run_id, expires_at) VALUES ('fake-perrun', $1, 'org-a', 'r-1', now() + interval '10 minutes')`, [boundKey]);
        const deps = { store, start: (i: Parameters<FleetEngine['start']>[0]) => engine.start(i), providerFor: (k: string) => (k === 'fake' ? provider : undefined), installation: 'it', now: () => Date.now(), log: () => undefined };
        // Two passes (two replicas, or a pass repeated): one workflow, one host.
        await reconcileOnce(deps);
        await reconcileOnce(deps);
        await until('the host to be created', async () => (await store.host(hostId))?.state === 'bootstrapping');
        expect(provider.hosts.size).toBe(1);

        // The cell on it registers (what the hub writes for a kcf_ token) and connects.
        await pool.query(`INSERT INTO runtime.runtime_cells (cell_id, owner, topology, certificate_serial, pool_id, host_id, bound_key, status) VALUES ('cell-h1', 'kodus', 'fleet', 'aa', 'fake-perrun', $1, $2, 'connected')`, [hostId, boundKey]);
        await pool.query(`INSERT INTO runtime.runtime_cell_sessions (cell_id, replica_id, replica_url, owner, driver, pool_id, bound_key) VALUES ('cell-h1', 'r', 'http://r', 'kodus', 'microvm', 'fake-perrun', $1)`, [boundKey]);
        await until('the host to be ready', async () => (await store.host(hostId))?.state === 'ready');

        // The Run is done: it stops asking and holds no claim.
        await pool.query(`UPDATE runtime.runtime_pool_demand SET expires_at = now() WHERE bound_key = $1`, [boundKey]);
        await until('the host to be terminated', async () => (await store.host(hostId))?.state === 'terminated');
        expect([...provider.hosts.values()][0].state).toBe('gone');
        expect(hub.retired).toEqual([hostId]);
        const events = (await pool.query(`SELECT to_state, reason FROM runtime.runtime_host_events WHERE host_id = $1 ORDER BY id`, [hostId])).rows;
        expect(events.map((e) => e.to_state)).toEqual(['requested', 'provisioning', 'bootstrapping', 'ready', 'terminating', 'terminated']);
        expect((await DBOS.getWorkflowStatus(perRunWorkflowId(hostId)))?.status).toBe('SUCCESS');
        // The token the host got was minted once and never reached the workflow's stored step outputs in the clear.
        const outputs = await DBOS.listWorkflowSteps(perRunWorkflowId(hostId));
        expect(JSON.stringify(outputs)).not.toContain(hub.minted[0].token);
    }, 60_000);
});
