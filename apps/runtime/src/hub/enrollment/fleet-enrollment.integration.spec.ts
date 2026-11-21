import { Pool } from 'pg';

import { FleetTokenLedger } from '@libs/runtime/contracts/fleet-token';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgHubStore } from '../hub-store';
import { FleetEnrollment } from './fleet-enrollment';
import { PgFleetTokenStore } from './pg-fleet-token.store';

// Opt-in: RUNTIME_IT_DATABASE_URL. docs/runtime/host-providers.md §8.1, F-02.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'fleet_enrollment');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('fleet enrollment (real Postgres)', () => {
    let pool: Pool;
    let store: PgHubStore;
    let fleet: FleetEnrollment;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 4 });
        await ensureRuntimeSchema(pool);
        await pool.query(`INSERT INTO runtime.runtime_host_pools (pool_id, scope, provider, lifecycle) VALUES ('boat-eu-perrun', 'kodus', 'boat', 'perRun')`);
        store = new PgHubStore(pool);
        fleet = new FleetEnrollment(store, new FleetTokenLedger(new PgFleetTokenStore(pool)), () => undefined);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    const register = (token: string, cellId: string) =>
        store.redeemFleetAndRegister(token, () => ({ cellId, organizationId: null, owner: 'kodus', topology: 'fleet', status: 'disconnected', certificateSerial: 'ab', certificateExpiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    const mint = async (hostId: string) => {
        const r = await fleet.mint({ hostId, poolId: 'boat-eu-perrun', boundKey: 'run:org-a/r-1', ttlSeconds: 600, issuedBy: 'runtime-fleet' });
        if (r.ok === false) throw new Error(r.reason);
        return r.token;
    };

    it("registers one Kodus cell of the token's pool and host, bound to its Run, and the session takes the binding at hello", async () => {
        const token = await mint('host-1');
        expect(await register(token, 'cell-f1')).toEqual({ ok: true, poolId: 'boat-eu-perrun', hostId: 'host-1', boundKey: 'run:org-a/r-1' });
        expect(await register(token, 'cell-f1b')).toEqual({ ok: false, reason: 'unknown_or_used' });
        const cell = (await pool.query(`SELECT owner, organization_id, topology, pool_id, host_id, bound_key FROM runtime.runtime_cells WHERE cell_id = 'cell-f1'`)).rows[0];
        expect(cell).toEqual({ owner: 'kodus', organization_id: null, topology: 'fleet', pool_id: 'boat-eu-perrun', host_id: 'host-1', bound_key: 'run:org-a/r-1' });
        await store.upsertSession({ cellId: 'cell-f1', replicaId: 'r', replicaUrl: 'http://r', owner: 'kodus', driver: 'microvm' });
        expect((await pool.query(`SELECT pool_id, bound_key FROM runtime.runtime_cell_sessions WHERE cell_id = 'cell-f1'`)).rows[0]).toEqual({ pool_id: 'boat-eu-perrun', bound_key: 'run:org-a/r-1' });
        // The host registered: it gets no second token.
        expect(await fleet.mint({ hostId: 'host-1', poolId: 'boat-eu-perrun', boundKey: null, ttlSeconds: 600, issuedBy: 'runtime-fleet' })).toEqual({ ok: false, reason: 'already_registered' });
    });

    it('a mint retried before the host was made replaces the unused token: the first one registers nothing', async () => {
        const first = await mint('host-2');
        const second = await mint('host-2');
        expect(await register(first, 'cell-f2a')).toEqual({ ok: false, reason: 'unknown_or_used' });
        expect((await register(second, 'cell-f2')).ok).toBe(true);
    });

    it("retiring a host cordons and revokes its cell and ends the cell's live claims", async () => {
        await pool.query(
            `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, side, state, lease_expires_at, hard_expires_at) VALUES ('c-live', 'cell-f2', 'org-a', 'base', 'bound', now() + interval '1 minute', now() + interval '1 hour')`,
        );
        expect(await fleet.retire('host-2', 'runtime-fleet')).toBe('cell-f2');
        const cell = (await pool.query(`SELECT status, cordoned_at IS NOT NULL AS cordoned FROM runtime.runtime_cells WHERE cell_id = 'cell-f2'`)).rows[0];
        expect(cell).toEqual({ status: 'revoked', cordoned: true });
        expect((await pool.query(`SELECT state FROM runtime.runtime_claims WHERE claim_id = 'c-live'`)).rows[0].state).toBe('terminated');
        expect(await fleet.retire('host-2', 'runtime-fleet')).toBe('cell-f2');
        expect(await fleet.retire('host-none', 'runtime-fleet')).toBeNull();
    });
});
