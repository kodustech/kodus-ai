import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { RuntimeMachineUsageReader } from '../domain/ports';
import type { RuntimeMachineUsageToday } from '../domain/machine-minutes-today';

/**
 * The org's machine minutes of the current UTC day (runtime.runtime_machine_usage,
 * migration 20) from the Runtime Postgres, read through the shared read-only
 * RuntimeReadDb (ADR-025): one aggregate on runtime_machine_reservations_org_day_idx.
 * Without RUNTIME_DATABASE_READ_URL it fails with 503, as every Runtime read does.
 */
export class PgRuntimeMachineUsageReader implements RuntimeMachineUsageReader {
    constructor(private readonly db: SqlQuery) {}

    async today(organizationId: string): Promise<RuntimeMachineUsageToday | undefined> {
        const row = (
            await this.db.query(
                `SELECT COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(held_seconds), 0) AS held, COUNT(*) FILTER (WHERE open) AS open
                   FROM runtime.runtime_machine_usage
                  WHERE org_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
                [organizationId],
            )
        ).rows[0] as { seconds: string; held: string; open: string } | undefined;
        return { seconds: Number(row?.seconds ?? 0), heldSeconds: Number(row?.held ?? 0), openRounds: Number(row?.open ?? 0) };
    }
}
