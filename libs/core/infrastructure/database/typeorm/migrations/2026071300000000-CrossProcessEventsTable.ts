import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `kodus_cross_process_events` table used by
 * `CrossProcessEventsBridge` to hop EventEmitter2 payloads between the API
 * and worker containers via Postgres LISTEN/NOTIFY.
 *
 * The bridge itself has an `ensureInfra()` step that runs a `CREATE TABLE IF
 * NOT EXISTS` on boot — but that step is gated on a successful raw `pg.Client`
 * connect. When that connect failed (e.g. the TLS mis-config in prod on
 * 2026-07-13), the table was never created and every publish `INSERT` from
 * TypeORM raised `relation "kodus_cross_process_events" does not exist` at
 * runtime. Anchoring the schema in a proper TypeORM migration removes that
 * fragility: the table always exists on any environment past the migration
 * runner, so a broken LISTEN degrades gracefully to "envelopes recorded but
 * not re-emitted" instead of a hard write error hammering the log.
 */
export class CrossProcessEventsTable2026071300000000
    implements MigrationInterface
{
    name = 'CrossProcessEventsTable2026071300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "kodus_cross_process_events" (
                "id" bigserial PRIMARY KEY,
                "envelope" jsonb NOT NULL,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        // Backs the bridge's opportunistic TTL sweep
        //   DELETE FROM kodus_cross_process_events
        //     WHERE created_at < now() - interval '60 minutes'
        // Without it that DELETE is a seq scan, which is fine on a healthy
        // 60-min steady state but catastrophic during any window where the
        // LISTEN half is down and rows accumulate (millions of rows scanned
        // on every reconnect).
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_kodus_cross_process_events_created_at"
                ON "kodus_cross_process_events" ("created_at")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_kodus_cross_process_events_created_at"`,
        );
        await queryRunner.query(
            `DROP TABLE IF EXISTS "kodus_cross_process_events"`,
        );
    }
}
