import { Pool } from 'pg';

import { generateCellRegistrationToken } from '@libs/runtime/contracts/cell-token';

import { PgHubStore } from '../../hub/hub-store';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgCommandStore } from './pg-command-store';
import { ensureRuntimeSchema, RUNTIME_MIGRATIONS } from './runtime-schema';

// Opt-in: RUNTIME_IT_DATABASE_URL (locally postgres://runtime:runtime@localhost:5442/kodus_runtime_it).
// docs/runtime/host-providers.md §5.2: every cell belongs to exactly one pool, bound by the hub, never by the cell.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'host_pools');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const POOLS_VERSION = 39;

(skip ? describe.skip : describe)('host pools in the Runtime database (real Postgres)', () => {
    let pool: Pool;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 4 });
        await ensureRuntimeSchema(pool, RUNTIME_MIGRATIONS.filter((m) => m.version < POOLS_VERSION));
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    const poolOf = async (table: 'runtime_cells' | 'runtime_cell_sessions', cellId: string) =>
        (await pool.query(`SELECT pool_id FROM runtime.${table} WHERE cell_id = $1`, [cellId])).rows[0]?.pool_id;

    it('backfills every cell registered before pools existed: Kodus cells into kodus-static, an org cell into the org default pool, and its session follows', async () => {
        await pool.query(`INSERT INTO runtime.runtime_cells (cell_id, organization_id, owner, topology, certificate_serial) VALUES
            ('cell-managed', NULL, 'kodus', 'managed', 'aa'), ('cell-acme', 'acme', 'customer', 'hybrid', 'bb')`);
        await pool.query(`INSERT INTO runtime.runtime_cell_sessions (cell_id, replica_id, replica_url, owner, org_id, driver) VALUES
            ('cell-managed', 'r1', 'http://r1', 'kodus', NULL, 'docker-gvisor'), ('cell-acme', 'r1', 'http://r1', 'customer', 'acme', 'docker-gvisor')`);

        await ensureRuntimeSchema(pool);

        expect(await poolOf('runtime_cells', 'cell-managed')).toBe('kodus-static');
        expect(await poolOf('runtime_cells', 'cell-acme')).toBe('org:acme/default');
        expect(await poolOf('runtime_cell_sessions', 'cell-managed')).toBe('kodus-static');
        expect(await poolOf('runtime_cell_sessions', 'cell-acme')).toBe('org:acme/default');
        const pools = (await pool.query(`SELECT pool_id, scope, organization_id, provider, lifecycle FROM runtime.runtime_host_pools ORDER BY pool_id`)).rows;
        expect(pools).toEqual([
            { pool_id: 'kodus-static', scope: 'kodus', organization_id: null, provider: 'static', lifecycle: 'pooled' },
            { pool_id: 'org:acme/default', scope: 'org:acme', organization_id: 'acme', provider: 'static', lifecycle: 'pooled' },
        ]);
    });

    it("a cell that registers with an org's token joins that org's default static pool, which the hub creates in the same transaction", async () => {
        const store = new PgHubStore(pool);
        const { token, tokenHash } = generateCellRegistrationToken();
        await new PgCommandStore(pool).insert({ tokenHash, organizationId: 'globex', topology: 'hybrid', expiresAt: new Date(Date.now() + 60_000).toISOString(), issuedBy: 'u-1' });
        const r = await store.redeemAndRegister(token, undefined, (redeemed) => ({
            cellId: 'cell-globex',
            organizationId: redeemed.organizationId,
            owner: 'customer',
            topology: redeemed.topology,
            status: 'disconnected',
            certificateSerial: 'cc',
            certificateExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }));
        expect(r.ok).toBe(true);
        expect(await poolOf('runtime_cells', 'cell-globex')).toBe('org:globex/default');
        expect((await pool.query(`SELECT provider FROM runtime.runtime_host_pools WHERE pool_id = 'org:globex/default'`)).rows[0]?.provider).toBe('static');
    });

    it("a cell's session takes its pool, host binding and cordon from the cell row at hello; nothing the cell says sets them", async () => {
        const store = new PgHubStore(pool);
        await store.upsertManagedCell({ cellId: 'cell-dev', certificateSerial: 'dd', certificateExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
        expect(await poolOf('runtime_cells', 'cell-dev')).toBe('kodus-static');
        await pool.query(`UPDATE runtime.runtime_cells SET cordoned_at = now() WHERE cell_id = 'cell-dev'`);
        await store.upsertSession({ cellId: 'cell-dev', replicaId: 'r1', replicaUrl: 'http://r1', owner: 'kodus', driver: 'docker-gvisor', ...({ poolId: 'boat-eu-perrun' } as object) });
        const s = (await pool.query(`SELECT pool_id, bound_key, cordoned_at FROM runtime.runtime_cell_sessions WHERE cell_id = 'cell-dev'`)).rows[0];
        expect(s.pool_id).toBe('kodus-static');
        expect(s.bound_key).toBeNull();
        expect(s.cordoned_at).not.toBeNull();
    });

    it('a session with no cell row (the plaintext test mode) is pooled by its owner', async () => {
        const store = new PgHubStore(pool);
        await store.upsertSession({ cellId: 'cell-plain', replicaId: 'r1', replicaUrl: 'http://r1', owner: 'customer', orgId: 'initech', driver: 'fake' });
        expect(await poolOf('runtime_cell_sessions', 'cell-plain')).toBe('org:initech/default');
    });
});
