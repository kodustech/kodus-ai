import { randomUUID } from 'crypto';

import { Pool } from 'pg';

import { claimHeldMinutes } from '@libs/runtime/api/domain/run-cost';
import { PgRuntimeClaimUsageReader } from '@libs/runtime/api/infrastructure/pg-runtime-claim-usage.reader';
import { RuntimeReadDb } from '@libs/runtime/api/infrastructure/runtime-read-db';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgHubStore } from '../hub-store';
import { PgMachineMinuteStore } from './pg-machine-minutes.store';

// Cost audit (machine side): the org day budget (runtime_machine_usage) and
// the Run cost (runtime_claims read by the API) are two computations of the
// same machine time. Opt-in: runs against RUNTIME_IT_DATABASE_URL (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), skipped without it.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'cost_audit');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const HOUR = 3_600;

(skip ? describe.skip : describe)('machine time: org day budget against the Run cost (cost audit, real Postgres)', () => {
    let pool: Pool;
    let budget: PgMachineMinuteStore;
    let hub: PgHubStore;
    let reader: PgRuntimeClaimUsageReader;
    let readDb: RuntimeReadDb;
    const org = () => `it-org-${randomUUID()}`;

    const recordClaim = (claimId: string, orgId: string, runId: string) =>
        hub.insertClaim({
            claimId,
            cellId: 'cell-a',
            orgId,
            runId,
            side: 'pr',
            state: 'pending',
            consumer: 'runtime',
            metering: { driver: 'docker-gvisor', bootMb: 2_048, readyMb: 2_048, allocatableMb: 14_745 },
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            hardExpiresAt: new Date(Date.now() + HOUR * 1000).toISOString(),
        });
    /** Moves the claim's current round (its reservation and its row) back in time, as if admitted `minutes` ago. */
    const admittedAgo = async (claimId: string, minutes: number) => {
        await pool.query(`UPDATE runtime.runtime_machine_reservations SET round_started_at = now() - make_interval(mins => $2) WHERE claim_id = $1`, [claimId, minutes]);
        await pool.query(`UPDATE runtime.runtime_claims SET admitted_at = now() - make_interval(mins => $2) WHERE claim_id = $1`, [claimId, minutes]);
    };
    const changedAgo = (claimId: string, minutes: number) =>
        pool.query(`UPDATE runtime.runtime_claims SET state_changed_at = now() - make_interval(mins => $2) WHERE claim_id = $1`, [claimId, minutes]);
    const budgetHeldMinutes = async (claimId: string) =>
        Number((await pool.query(`SELECT held_seconds FROM runtime.runtime_machine_usage WHERE claim_id = $1`, [claimId])).rows[0].held_seconds) / 60;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 4 });
        await ensureRuntimeSchema(pool);
        budget = new PgMachineMinuteStore(pool);
        hub = new PgHubStore(pool);
        readDb = new RuntimeReadDb(url);
        reader = new PgRuntimeClaimUsageReader(readDb);
    });

    afterAll(async () => {
        await readDb?.onModuleDestroy();
        await pool?.end();
        await database.drop();
    });

    // KNOWN DEFECT (cost-audit): the budget keeps a retried round's earlier time (settled_seconds) but the claim row the Run cost reads is overwritten on rebind (admitted_at = now()).
    it.failing('the Run cost of a claim with two rounds counts the machine time the org day budget counts for it', async () => {
        const orgId = org();
        const runId = `run-${randomUUID()}`;
        const claimId = `c-${randomUUID()}`;
        // Round 1: admitted 30 min ago, lost 20 min ago (the cell dropped during the boot).
        await budget.reserve({ claimId, organizationId: orgId, needSeconds: HOUR, limitMinutes: 0 });
        await recordClaim(claimId, orgId, runId);
        await admittedAgo(claimId, 30);
        await hub.transitionClaim(claimId, ['pending'], 'failed', { reason: 'not_ready', detail: 'disconnected' });
        await changedAgo(claimId, 20);
        // Round 2: the worker asks again with the same key 10 min ago; it ends now.
        await budget.reserve({ claimId, organizationId: orgId, needSeconds: HOUR, limitMinutes: 0 });
        await hub.rebindClaim(claimId, {
            cellId: 'cell-a',
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            hardExpiresAt: new Date(Date.now() + HOUR * 1000).toISOString(),
            metering: { driver: 'docker-gvisor', bootMb: 2_048, readyMb: 2_048, allocatableMb: 14_745 },
        });
        await admittedAgo(claimId, 10);
        await hub.transitionClaim(claimId, ['pending'], 'released', { reason: 'released' });

        const budgetMinutes = await budgetHeldMinutes(claimId);
        expect(budgetMinutes).toBeGreaterThanOrEqual(20);
        const [row] = (await reader.claimsOfRuns(orgId, [runId])).get(runId)!;
        const costMinutes = claimHeldMinutes(row, new Date())!;
        expect(Math.abs(costMinutes - budgetMinutes)).toBeLessThan(0.5);
    });

    // KNOWN DEFECT (cost-audit): a claim's every round is counted on the UTC day of its first round (reserve keeps prior.day), so a retry after midnight is judged by yesterday's total.
    it.failing("a claim's new round after midnight is admitted against the new UTC day, not the day its first round fell on", async () => {
        const orgId = org();
        const limitMinutes = 90;
        // Yesterday: another claim used 80 of the 90 minutes, and this claim's first round failed after 5.
        const other = `c-${randomUUID()}`;
        const claimId = `c-${randomUUID()}`;
        for (const id of [other, claimId]) {
            await budget.reserve({ claimId: id, organizationId: orgId, needSeconds: 0, limitMinutes: 0 });
            await recordClaim(id, orgId, `run-${randomUUID()}`);
        }
        await pool.query(`UPDATE runtime.runtime_machine_reservations SET day = day - 1, settled_seconds = 4800 WHERE claim_id = $1`, [other]);
        await pool.query(`UPDATE runtime.runtime_machine_reservations SET day = day - 1, round_reserved_seconds = 300, round_started_at = now() - interval '25 hours' WHERE claim_id = $1`, [claimId]);
        await hub.transitionClaim(claimId, ['pending'], 'failed', { reason: 'not_ready', detail: 'disconnected' });
        await pool.query(`UPDATE runtime.runtime_claims SET state_changed_at = now() - interval '24 hours 55 minutes' WHERE claim_id = $1`, [claimId]);

        // Today nothing is spent: a one-hour round of this claim fits today's 90 minutes.
        expect(await budget.spentToday(orgId)).toEqual({ seconds: 0, openClaims: 0 });
        expect(await budget.reserve({ claimId, organizationId: orgId, needSeconds: HOUR, limitMinutes })).toEqual({ allowed: true });
        expect((await budget.spentToday(orgId)).seconds).toBe(HOUR);
    });
});
