import { Pool, type PoolClient } from 'pg';

import { inTransaction, lockKey, lockStatement, withTransaction } from '@libs/runtime/run/adapters/advisory-lock';
import { decideMachineMinutes, effectiveMachineMinuteLimit, machineMinuteLimitSource, type MachineMinutesDecision } from '@libs/runtime/environment';

import type { MachineMinuteStore } from './machine-minutes';

/**
 * The org's machine-minute budget in the Runtime Postgres (migration 20).
 * What a claim counts is derived from its own row in runtime_claims
 * (runtime_machine_usage): the hub never has to settle a round, so a round
 * that ends by the lease, the reaper or a revocation counts what it held as
 * surely as one the hub released. A reserve decides and writes under the
 * org day's transaction-scoped advisory lock, so two reserves of one org (on
 * any replica) see each other's minutes and never both pass the last ones.
 */
export class PgMachineMinuteStore implements MachineMinuteStore {
    constructor(private readonly db: Pool | PoolClient) {}

    async reserve(input: { claimId: string; organizationId: string; needSeconds: number; limitMinutes: number }): Promise<MachineMinutesDecision> {
        if (!Number.isSafeInteger(input.needSeconds) || input.needSeconds < 0) throw new Error(`a machine reservation is whole seconds, got ${input.needSeconds}`);
        return this.inTransaction(async (db) => {
            const dayOf = async () =>
                (
                    await db.query<{ org_id: string; day: string }>(
                        `SELECT org_id, day::text AS day FROM runtime.runtime_machine_reservations WHERE claim_id = $1`,
                        [input.claimId],
                    )
                ).rows[0];
            const prior = await dayOf();
            if (prior && prior.org_id !== input.organizationId) throw new Error('the claim is counted under another organization');
            const day = prior?.day ?? (await db.query<{ day: string }>(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS day`)).rows[0].day;
            const lock = lockStatement('pg_advisory_xact_lock', lockKey('machine_minutes_org_day', input.organizationId, day));
            await db.query(lock.text, lock.values);

            // Under the lock: the other claims of the day at what they count, this claim's earlier rounds at what they held.
            const r = await db.query<{ others: string; mine: string | null }>(
                `SELECT COALESCE(SUM(seconds) FILTER (WHERE claim_id <> $3), 0) AS others,
                        MAX(held_seconds) FILTER (WHERE claim_id = $3) AS mine
                   FROM runtime.runtime_machine_usage WHERE org_id = $1 AND day = $2::date`,
                [input.organizationId, day, input.claimId],
            );
            const held = Number(r.rows[0].mine ?? 0);
            // The org's own limit (runtime_org_machine_budget), read in this transaction: a change applies to the next reserve.
            const own = await db.query<{ minutes_per_day: number | null }>(
                `SELECT minutes_per_day FROM runtime.runtime_org_machine_budget WHERE organization_id = $1`,
                [input.organizationId],
            );
            const orgMinutes = own.rows[0]?.minutes_per_day ?? null;
            const limitMinutes = effectiveMachineMinuteLimit(input.limitMinutes, orgMinutes);
            const decision = decideMachineMinutes({ spentSeconds: Number(r.rows[0].others) + held, needSeconds: input.needSeconds, limitMinutes });
            if (!decision.allowed) return { ...decision, source: machineMinuteLimitSource(input.limitMinutes, orgMinutes) };
            await db.query(
                `INSERT INTO runtime.runtime_machine_reservations (claim_id, org_id, day, settled_seconds, round_started_at, round_reserved_seconds)
                 VALUES ($1, $2, $3::date, 0, now(), $4)
                 ON CONFLICT (claim_id) DO UPDATE SET settled_seconds = $5, round_started_at = now(), round_reserved_seconds = $4`,
                [input.claimId, input.organizationId, day, input.needSeconds, held],
            );
            return decision;
        });
    }

    async cancel(claimId: string): Promise<void> {
        // Only ever lowers what the day counts, so it needs no lock.
        await this.db.query(`UPDATE runtime.runtime_machine_reservations SET round_reserved_seconds = 0 WHERE claim_id = $1`, [claimId]);
    }

    /** What the org's UTC day counts now (ended rounds at what they held, rounds in flight at their ceiling), and how many are in flight. */
    /** The org's own daily machine minutes; null = the deployment's limit. */
    async orgLimit(organizationId: string): Promise<number | null> {
        const r = await this.db.query<{ minutes_per_day: number | null }>(`SELECT minutes_per_day FROM runtime.runtime_org_machine_budget WHERE organization_id = $1`, [organizationId]);
        return r.rows[0]?.minutes_per_day ?? null;
    }

    async spentToday(organizationId: string): Promise<{ seconds: number; openClaims: number }> {
        const r = await this.db.query<{ seconds: string; open: string }>(
            `SELECT COALESCE(SUM(seconds), 0) AS seconds, COUNT(*) FILTER (WHERE open) AS open
               FROM runtime.runtime_machine_usage WHERE org_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
            [organizationId],
        );
        return { seconds: Number(r.rows[0].seconds), openClaims: Number(r.rows[0].open) };
    }

    private async inTransaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
        const own = this.db instanceof Pool;
        if (own) return withTransaction(this.db as Pool, fn);
        const client = this.db as PoolClient;
        return inTransaction(client, () => fn(client));
    }
}
