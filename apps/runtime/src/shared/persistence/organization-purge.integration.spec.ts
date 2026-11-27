import { randomUUID } from 'crypto';

import { Pool } from 'pg';

import { isolatedDatabase } from '../../testing/isolated-database';
import { ORGANIZATION_PURGE_CHILDREN, ORGANIZATION_PURGE_TABLES, PgOrganizationPurgeStore } from './organization-purge';
import { ensureRuntimeSchema } from './runtime-schema';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'organization_purge');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

// Columns a CHECK constraint pins to a value the generic seed cannot guess.
const PINNED: Record<string, Record<string, unknown>> = {
    runtime_previews: { side: 'pr', state: 'expired' },
    runtime_hosts: { state: 'terminated' },
    runtime_host_pools: { scope: 'org:pool', lifecycle: 'pooled' },
    runtime_cell_sessions: { owner: 'customer' },
    runtime_cells: { owner: 'customer' },
    runtime_stops: { scope: 'org' },
    runtime_pr_images: { state: 'ready' },
    runtime_pr_run_generations: { generation: 1 },
    runtime_sandbox_audit: { outcome: 'ok' },
    runtime_preview_audit: { action: 'started' },
    runtime_kept_check_results: { outcome: 'passed' },
    runtime_shared_images: { fingerprint: 'a'.repeat(64), digest: `sha256:${'b'.repeat(64)}` },
    runtime_env_templates: { fingerprint: 'c'.repeat(32), snapshot_name: 'snapshot-a', state: 'ready' },
    runtime_admission_requests: { kind: 'run', state: 'completed', generation: 0, payload_bytes: 0, owner_epoch: 0 },
};

(skip ? describe.skip : describe)('organization purge (real Postgres)', () => {
    let pool: Pool;
    let store: PgOrganizationPurgeStore;
    const columns = new Map<string, Array<{ name: string; type: string; nullable: boolean; hasDefault: boolean }>>();

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        store = new PgOrganizationPurgeStore(pool);
        const { rows } = await pool.query(
            `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns c WHERE table_schema = 'runtime' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'runtime' AND table_type = 'BASE TABLE') ORDER BY table_name, ordinal_position`,
        );
        for (const r of rows) {
            const list = columns.get(r.table_name) ?? [];
            list.push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', hasDefault: r.column_default !== null });
            columns.set(r.table_name, list);
        }
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    /** One row of `table` for `tag`: the org column set, every other required column a value derived from its name and the tag. */
    async function seed(table: string, tag: string, orgColumn: string | undefined, pinned: Record<string, unknown> = {}) {
        const values: Record<string, unknown> = {};
        for (const c of columns.get(table)!) {
            if (c.name === orgColumn) values[c.name] = `org-${tag}`;
            else if (c.name in pinned) values[c.name] = pinned[c.name];
            else if (c.name in (PINNED[table] ?? {})) values[c.name] = PINNED[table][c.name];
            else if (c.nullable || c.hasDefault) continue;
            else if (c.type === 'integer' || c.type === 'bigint' || c.type === 'smallint') values[c.name] = 1;
            else if (c.type === 'boolean') values[c.name] = false;
            else if (c.type.startsWith('timestamp') || c.type === 'date') values[c.name] = new Date();
            else if (c.type === 'jsonb' || c.type === 'json') values[c.name] = '{}';
            else if (c.type === 'ARRAY') values[c.name] = '{}';
            else if (c.type === 'uuid') values[c.name] = randomUUID();
            else values[c.name] = `${c.name}-${tag}`;
        }
        const names = Object.keys(values);
        await pool.query(`INSERT INTO runtime.${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values));
    }

    const count = async (table: string, where = 'true', params: unknown[] = []) => Number((await pool.query(`SELECT count(*)::int AS n FROM runtime.${table} WHERE ${where}`, params)).rows[0].n);

    it('names every runtime table that carries an organization column, so a new one cannot be forgotten', () => {
        const withOrg = [...columns.entries()].filter(([, cols]) => cols.some((c) => c.name === 'org_id' || c.name === 'organization_id')).map(([t]) => t);
        expect(ORGANIZATION_PURGE_TABLES.map(([t]) => t).sort()).toEqual(withOrg.sort());
        for (const [table, column] of ORGANIZATION_PURGE_TABLES) expect(columns.get(table)!.map((c) => c.name)).toContain(column);
        // A child that has no organization column of its own is reached through a row that does.
        const named = new Set(ORGANIZATION_PURGE_TABLES.map(([t]) => t));
        for (const [table] of ORGANIZATION_PURGE_CHILDREN.filter(([t]) => !named.has(t))) {
            const names = columns.get(table)!.map((c) => c.name);
            expect(names).not.toContain('org_id');
            expect(names).not.toContain('organization_id');
        }
    });

    it('removes every row of one organization from every table and the children reached through its rows, and nothing of the other', async () => {
        for (const tag of ['a', 'b']) {
            // A host's pool first: runtime_hosts.pool_id is the schema's one foreign key.
            for (const [table, column] of [...ORGANIZATION_PURGE_TABLES.filter(([t]) => t === 'runtime_host_pools'), ...ORGANIZATION_PURGE_TABLES.filter(([t]) => t !== 'runtime_host_pools')]) await seed(table, tag, column);
            // The children, linked to the org's own run, cell and (terminated) host.
            await seed('runtime_fork_approvals', tag, undefined, { run_id: `run_id-${tag}` });
            await seed('runtime_cell_revocations', tag, undefined, { cell_id: `cell_id-${tag}` });
            await seed('runtime_preview_tunnels', tag, undefined, { cell_id: `cell_id-${tag}` });
            await seed('runtime_host_events', tag, undefined, { host_id: `host_id-${tag}` });
            await seed('runtime_fleet_tokens', tag, undefined, { host_id: `host_id-${tag}` });
        }
        // The seed is complete: every table the purge names holds one row of each organization.
        for (const [table, column] of ORGANIZATION_PURGE_TABLES) {
            expect([table, await count(table, `${column} = $1`, ['org-a'])]).toEqual([table, 1]);
        }

        const out = await store.deleteOrganization('org-a', 1);

        expect(out.hostsKept).toBe(0);
        for (const [table, column] of ORGANIZATION_PURGE_TABLES) {
            expect([table, await count(table, `${column} = $1`, ['org-a']), await count(table, `${column} = $1`, ['org-b'])]).toEqual([table, 0, 1]);
        }
        for (const [table, column] of [
            ['runtime_fork_approvals', 'run_id'],
            ['runtime_cell_revocations', 'cell_id'],
            ['runtime_preview_tunnels', 'cell_id'],
            ['runtime_host_events', 'host_id'],
            ['runtime_fleet_tokens', 'host_id'],
        ] as const) {
            expect([table, await count(table, `${column} LIKE '%-a'`), await count(table, `${column} LIKE '%-b'`)]).toEqual([table, 0, 1]);
        }
        expect(out.deleted.runtime_runs).toBe(1);
        // The summary names tables and counts only.
        expect(Object.values(out.deleted).every((n) => Number.isInteger(n))).toBe(true);

        // A second purge finds nothing, and the other organization is still whole.
        expect((await store.deleteOrganization('org-a')).deleted).toEqual({});
        expect(await count('runtime_runs', `organization_id = 'org-b'`)).toBe(1);
    });

    it('keeps a host that is not terminated, with its pool, until runtime-fleet ends it; a second purge then removes them', async () => {
        await seed('runtime_host_pools', 'c', 'organization_id');
        await seed('runtime_hosts', 'c', 'organization_id', { state: 'ready', pool_id: 'pool_id-c' });
        expect(await store.cordonPools('org-c')).toBe(1);
        expect(await store.cordonPools('org-c')).toBe(0);

        const first = await store.deleteOrganization('org-c');
        expect(first.hostsKept).toBe(1);
        expect(await count('runtime_hosts', `organization_id = 'org-c'`)).toBe(1);
        expect(await count('runtime_host_pools', `organization_id = 'org-c'`)).toBe(1);

        await pool.query(`UPDATE runtime.runtime_hosts SET state = 'terminated', terminated_at = now() WHERE organization_id = 'org-c'`);
        const second = await store.deleteOrganization('org-c');
        expect(second.hostsKept).toBe(0);
        expect(second.deleted).toMatchObject({ runtime_hosts: 1, runtime_host_pools: 1 });
    });

    it("lists the organization's claims that were not released, and only those", async () => {
        const claim = (id: string, org: string, released: boolean) =>
            pool.query(
                `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, run_id, side, state, lease_expires_at, hard_expires_at, released_at) VALUES ($1, 'cell-1', $2, 'run-1', 'pr', 'bound', now(), now(), $3)`,
                [id, org, released ? new Date() : null],
            );
        await claim('live-d', 'org-d', false);
        await claim('done-d', 'org-d', true);
        await claim('live-e', 'org-e', false);
        expect(await store.liveClaims('org-d')).toEqual([{ claimId: 'live-d', runId: 'run-1' }]);
        expect(await store.liveClaims('org-nobody')).toEqual([]);
    });
});
