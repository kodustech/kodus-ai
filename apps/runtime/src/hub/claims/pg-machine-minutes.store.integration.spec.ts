import { randomUUID } from 'crypto';

import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgHubStore } from '../hub-store';
import { PgMachineMinuteStore } from './pg-machine-minutes.store';

// Opt-in: runs against RUNTIME_IT_DATABASE_URL (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), skipped without it.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'machine_minutes');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const HOUR = 3_600;

(skip ? describe.skip : describe)('org machine-minute budget (integration, real Postgres)', () => {
    let pool: Pool;
    let budget: PgMachineMinuteStore;
    let hub: PgHubStore;
    const org = () => `it-org-${randomUUID()}`;

    /** A claim row as the hub records it when it admits a round. */
    const recordClaim = async (claimId: string, orgId: string) => {
        await hub.insertClaim({
            claimId,
            cellId: 'cell-a',
            orgId,
            side: 'base',
            state: 'pending',
            consumer: 'runtime',
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            hardExpiresAt: new Date(Date.now() + HOUR * 1000).toISOString(),
        });
    };
    /** Moves the reserved round of a claim back in time, as if it started `minutes` ago. */
    const startedAgo = (claimId: string, minutes: number) =>
        pool.query(`UPDATE runtime.runtime_machine_reservations SET round_started_at = now() - make_interval(mins => $2) WHERE claim_id = $1`, [claimId, minutes]);

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 6 });
        await ensureRuntimeSchema(pool);
        budget = new PgMachineMinuteStore(pool);
        hub = new PgHubStore(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    it('lets only one of two claims racing on separate connections take the last hour of the org day', async () => {
        const orgId = org();
        // 90 minutes a day, 60 reserved per claim: one fits, two do not.
        const limitMinutes = 90;
        const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
        try {
            const outcomes = await Promise.all([
                new PgMachineMinuteStore(a).reserve({ claimId: `c-${randomUUID()}`, organizationId: orgId, needSeconds: HOUR, limitMinutes }),
                new PgMachineMinuteStore(b).reserve({ claimId: `c-${randomUUID()}`, organizationId: orgId, needSeconds: HOUR, limitMinutes }),
            ]);
            expect(outcomes.filter((o) => o.allowed)).toHaveLength(1);
            expect(outcomes.find((o) => !o.allowed)).toEqual({ allowed: false, spentMinutes: 60, limitMinutes: 90, needMinutes: 60 });
        } finally {
            a.release();
            b.release();
        }
        expect(await budget.spentToday(orgId)).toEqual({ seconds: HOUR, openClaims: 1 });
    });

    it('counts a claim that ended by the minutes it held, not by the ceiling it reserved', async () => {
        const orgId = org();
        const claimId = `c-${randomUUID()}`;
        expect(await budget.reserve({ claimId, organizationId: orgId, needSeconds: HOUR, limitMinutes: 100 })).toEqual({ allowed: true });
        await recordClaim(claimId, orgId);
        await startedAgo(claimId, 10);
        await hub.transitionClaim(claimId, ['pending'], 'released', { reason: 'released' });
        const spent = await budget.spentToday(orgId);
        expect(spent.openClaims).toBe(0);
        expect(spent.seconds).toBeGreaterThanOrEqual(600);
        expect(spent.seconds).toBeLessThan(620);
        // What the ended claim gave back now fits a second one.
        expect(await budget.reserve({ claimId: `c-${randomUUID()}`, organizationId: orgId, needSeconds: HOUR, limitMinutes: 100 })).toEqual({ allowed: true });
    });

    it('counts a claim that is still open by its whole reserved ceiling', async () => {
        const orgId = org();
        const claimId = `c-${randomUUID()}`;
        await budget.reserve({ claimId, organizationId: orgId, needSeconds: HOUR, limitMinutes: 0 });
        await recordClaim(claimId, orgId);
        await startedAgo(claimId, 10);
        expect(await budget.spentToday(orgId)).toEqual({ seconds: HOUR, openClaims: 1 });
    });

    it('gives back every minute of a round cancelled before it reached a cell', async () => {
        const orgId = org();
        const claimId = `c-${randomUUID()}`;
        await budget.reserve({ claimId, organizationId: orgId, needSeconds: HOUR, limitMinutes: 60 });
        await budget.cancel(claimId);
        expect(await budget.spentToday(orgId)).toEqual({ seconds: 0, openClaims: 0 });
        expect(await budget.reserve({ claimId: `c-${randomUUID()}`, organizationId: orgId, needSeconds: HOUR, limitMinutes: 60 })).toEqual({ allowed: true });
    });

    it('counts a retried round on top of what the earlier round of the same claim held', async () => {
        const orgId = org();
        const claimId = `c-${randomUUID()}`;
        await budget.reserve({ claimId, organizationId: orgId, needSeconds: HOUR, limitMinutes: 0 });
        await recordClaim(claimId, orgId);
        await startedAgo(claimId, 20);
        await hub.transitionClaim(claimId, ['pending'], 'failed', { reason: 'not_ready' });
        await budget.reserve({ claimId, organizationId: orgId, needSeconds: HOUR, limitMinutes: 0 });
        const spent = await budget.spentToday(orgId);
        expect(spent.openClaims).toBe(1);
        expect(spent.seconds).toBeGreaterThanOrEqual(HOUR + 1_200);
        expect(spent.seconds).toBeLessThan(HOUR + 1_220);
    });

    it("never counts another org's minutes against this org", async () => {
        const [mine, theirs] = [org(), org()];
        await budget.reserve({ claimId: `c-${randomUUID()}`, organizationId: theirs, needSeconds: HOUR, limitMinutes: 60 });
        expect(await budget.reserve({ claimId: `c-${randomUUID()}`, organizationId: mine, needSeconds: HOUR, limitMinutes: 60 })).toEqual({ allowed: true });
    });
});
