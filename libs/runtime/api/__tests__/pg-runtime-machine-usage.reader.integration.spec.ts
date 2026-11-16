import { randomBytes } from 'crypto';

import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../../../apps/runtime/src/shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';
import { PgRuntimeMachineUsageReader } from '../infrastructure/pg-runtime-machine-usage.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';

// Opt-in: runs against RUNTIME_IT_DATABASE_URL (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), skipped without it.
const base = process.env.RUNTIME_IT_DATABASE_URL;
const database = isolatedDatabase(base ?? '', 'machine_usage_reader');

(base && process.env.SKIP_INTEGRATION !== 'true' ? describe : describe.skip)('machine usage reader (integration, real Postgres)', () => {
    let owner: Pool;
    let reader: PgRuntimeMachineUsageReader;
    let readDb: RuntimeReadDb;

    beforeAll(async () => {
        await database.create();
        owner = new Pool({ connectionString: database.url, max: 2 });
        owner.on('error', () => undefined);
        await ensureRuntimeSchema(owner);
        // The API's role, with SELECT on the view only (scripts/runtime/dev-runtime-users.sh).
        const role = `machine_reader_${randomBytes(6).toString('hex')}`;
        const password = randomBytes(24).toString('hex');
        await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
        await owner.query(`GRANT USAGE ON SCHEMA runtime TO "${role}"`);
        await owner.query(`GRANT SELECT ON runtime.runtime_machine_usage TO "${role}"`);
        const restricted = new URL(database.url);
        restricted.username = role;
        restricted.password = password;
        readDb = new RuntimeReadDb(restricted.toString());
        reader = new PgRuntimeMachineUsageReader(readDb);
    });

    afterAll(async () => {
        await readDb?.onModuleDestroy();
        await owner?.end();
        await database.drop();
    });

    const reserve = (claimId: string, orgId: string, day: string, settled: number, reserved: number, startedMinutesAgo: number) =>
        owner.query(
            `INSERT INTO runtime.runtime_machine_reservations (claim_id, org_id, day, settled_seconds, round_started_at, round_reserved_seconds)
             VALUES ($1, $2, $3::date, $4, now() - make_interval(mins => $6), $5)`,
            [claimId, orgId, day, settled, reserved, startedMinutesAgo],
        );

    it("sums only the caller's org on the current UTC day, with a role that may only read the view", async () => {
        const today = (await owner.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS d`)).rows[0].d;
        const yesterday = (await owner.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'UTC')::date - 1)::text AS d`)).rows[0].d;
        await reserve('ended', 'org-a', today, 600, 0, 30);
        await reserve('running', 'org-a', today, 0, 3_600, 10);
        await reserve('yesterday', 'org-a', yesterday, 6_000, 0, 1_500);
        await reserve('other-org', 'org-b', today, 9_000, 0, 30);

        const usage = await reader.today('org-a');

        expect(usage?.seconds).toBe(600 + 3_600);
        expect(usage?.heldSeconds).toBeGreaterThanOrEqual(1_200);
        expect(usage?.heldSeconds).toBeLessThan(1_300);
        expect(usage?.openRounds).toBe(1);
        expect(await reader.today('org-none')).toEqual({ seconds: 0, heldSeconds: 0, openRounds: 0 });
    });
});
