import { Pool } from 'pg';

import { PgRuntimeClaimUsageReader } from '../infrastructure/pg-runtime-claim-usage.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';

// Opt-in: RUNTIME_IT_DATABASE_URL. A claim on a fleet host's cell carries the host's US$/h; any other claim carries null.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('PgRuntimeClaimUsageReader fleet host price (real Postgres)', () => {
    let pool: Pool;
    const db = `claim_usage_it_${process.pid}`;
    let reader: PgRuntimeClaimUsageReader;
    let readDb: RuntimeReadDb;

    beforeAll(async () => {
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE DATABASE ${db}`);
        await admin.end();
        const dbUrl = url.replace(/\/[^/]*$/, `/${db}`);
        pool = new Pool({ connectionString: dbUrl, max: 1 });
        await pool.query(`CREATE SCHEMA runtime;
            CREATE TABLE runtime.runtime_hosts (host_id text PRIMARY KEY, usd_per_hour numeric);
            CREATE TABLE runtime.runtime_cells (cell_id text PRIMARY KEY, host_id text);
            CREATE TABLE runtime.runtime_claims (claim_id text PRIMARY KEY, cell_id text, run_id text, org_id text, side text, state text, driver text,
                memory_mb_boot int, memory_mb_ready int, memory_allocatable_mb int, cpus int, admitted_at timestamptz, ready_at timestamptz,
                released_at timestamptz, state_changed_at timestamptz, hard_expires_at timestamptz, created_at timestamptz DEFAULT now());
            INSERT INTO runtime.runtime_hosts VALUES ('host-1', '0.2016'), ('host-free', NULL);
            INSERT INTO runtime.runtime_cells VALUES ('cell-fleet', 'host-1'), ('cell-unpriced', 'host-free'), ('cell-static', NULL);
            INSERT INTO runtime.runtime_claims (claim_id, cell_id, run_id, org_id, side, state) VALUES
                ('k1', 'cell-fleet', 'run-1', 'org-a', 'base', 'released'),
                ('k2', 'cell-unpriced', 'run-1', 'org-a', 'pr', 'released'),
                ('k3', 'cell-static', 'run-1', 'org-a', 'pr', 'released'),
                ('k4', 'cell-gone', 'run-1', 'org-a', 'pr', 'released'),
                ('k5', 'cell-fleet', 'run-2', 'org-b', 'base', 'released')`);
        readDb = new RuntimeReadDb(dbUrl);
        reader = new PgRuntimeClaimUsageReader(readDb);
    });

    afterAll(async () => {
        await readDb?.onModuleDestroy();
        await pool?.end();
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`DROP DATABASE IF EXISTS ${db}`);
        await admin.end();
    });

    it("carries the fleet host's price on its cell's claim as a number, null on every other cell, and stays org-scoped", async () => {
        const rows = (await reader.claimsOfRuns('org-a', ['run-1', 'run-2'])).get('run-1')!;
        expect(Object.fromEntries(rows.map((c) => [c.claimId, c.hostUsdPerHour]))).toEqual({ k1: 0.2016, k2: null, k3: null, k4: null });
        expect((await reader.claimsOfRuns('org-a', ['run-2'])).size).toBe(0);
    });
});
