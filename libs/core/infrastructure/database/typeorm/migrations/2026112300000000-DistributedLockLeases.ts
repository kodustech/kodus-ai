import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Leases for DistributedLockService, replacing session advisory locks.
 *
 * An advisory lock lives in the Postgres session that took it. Behind a
 * pooler in transaction mode (PgBouncer, RDS Proxy) consecutive statements
 * from one client can run on different server sessions, so two holders got
 * the same key and released locks stayed held. A lease row behaves the same
 * on any connection.
 *
 *   lock_key        the caller's key
 *   holder          `host:pid:uuid` of one acquire — release and renew only
 *                   act while it still matches
 *   expires_at      renewed by the holder's heartbeat; past it, anyone may
 *                   take the key
 *   max_hold_until  the caller's ttl, fixed on acquire: expires_at never
 *                   passes it, so a holder that dies still frees the key
 *                   by then
 *
 * The expires_at index serves the sweep of leases crashed holders left
 * behind. Acquire and release go through the primary key.
 */
export class DistributedLockLeases2026112300000000 implements MigrationInterface {
    name = 'DistributedLockLeases2026112300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "kodus_workflow"`);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "kodus_workflow"."distributed_locks" (
                "lock_key" text PRIMARY KEY,
                "holder" text NOT NULL,
                "acquired_at" timestamptz NOT NULL DEFAULT now(),
                "expires_at" timestamptz NOT NULL,
                "max_hold_until" timestamptz NULL
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_distributed_locks_expires_at"
                ON "kodus_workflow"."distributed_locks" ("expires_at")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP TABLE IF EXISTS "kodus_workflow"."distributed_locks"`,
        );
    }
}
