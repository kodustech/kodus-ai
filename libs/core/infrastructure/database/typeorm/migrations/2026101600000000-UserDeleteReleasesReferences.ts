import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deleting a user failed whenever one of these rows pointed at it, because
 * every foreign key to `users` was ON DELETE NO ACTION and the user delete
 * only cleans profiles, permissions, auth and team members. Every invited
 * user gets a `team.member_invited` delivery, so removing a member answered
 * 500.
 *
 * - notification_deliveries: the delivery history stays, without the user
 *   (`recipientEmail` still names who it went to).
 * - user_notifications: the in-app inbox of a deleted user goes with it.
 * - cli_devices: the CLI device tokens of a deleted user go with it.
 * - team_cli_key: the key belongs to the team and keeps working; only the
 *   creator reference is cleared.
 */
const FOREIGN_KEYS = [
    {
        table: 'notification_deliveries',
        column: 'recipient_user_id',
        name: 'FK_754b483843ff095c71800e6997a',
        onDelete: 'SET NULL',
    },
    {
        table: 'user_notifications',
        column: 'user_id',
        name: 'FK_ae9b1d1f1fe780ef8e3e7d0c0f6',
        onDelete: 'CASCADE',
    },
    {
        table: 'cli_devices',
        column: 'user_id',
        name: 'FK_96896f50507d3e188375266610b',
        onDelete: 'CASCADE',
    },
    {
        table: 'team_cli_key',
        column: 'created_by_user_id',
        name: 'FK_2d6b2bee370911a1698fc57cebc',
        onDelete: 'SET NULL',
    },
];

export class UserDeleteReleasesReferences2026101600000000 implements MigrationInterface {
    name = 'UserDeleteReleasesReferences2026101600000000';

    // Each statement commits on its own so the long step, validating the
    // existing rows, runs under VALIDATE's lock instead of holding the
    // table locked; see setOnDelete.
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.withLockTimeout(queryRunner, async () => {
            for (const fk of FOREIGN_KEYS) {
                await this.setOnDelete(queryRunner, fk, fk.onDelete);
            }
        });
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await this.withLockTimeout(queryRunner, async () => {
            for (const fk of FOREIGN_KEYS) {
                await this.setOnDelete(queryRunner, fk, 'NO ACTION');
            }
        });
    }

    /**
     * A statement waiting for a lock queues every write to the table behind
     * it. Fail instead, so the deploy stops and can be retried, rather than
     * stalling writes to `users` and the notification tables.
     */
    private async withLockTimeout(
        queryRunner: QueryRunner,
        run: () => Promise<void>,
    ): Promise<void> {
        await queryRunner.query(`SET lock_timeout = '10s'`);
        try {
            await run();
        } finally {
            await queryRunner.query(`RESET lock_timeout`);
        }
    }

    /**
     * Swaps the constraint without a window where the column is unchecked:
     * the new one is added NOT VALID (enforced for new rows, brief lock),
     * replaces the old one under the same name, and is validated last,
     * which scans the table without blocking writes. Each step commits on
     * its own, so a run that stopped halfway is resumed, not repeated.
     */
    private async setOnDelete(
        queryRunner: QueryRunner,
        fk: (typeof FOREIGN_KEYS)[number],
        onDelete: string,
    ): Promise<void> {
        const swap = `${fk.name}_swap`;
        const exists = async (name: string) =>
            (
                await queryRunner.query(
                    `SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
                    [fk.table, name],
                )
            ).length > 0;

        // Stopped after dropping the old constraint: only the rename is left.
        if ((await exists(fk.name)) || !(await exists(swap))) {
            await queryRunner.query(
                `ALTER TABLE "${fk.table}" DROP CONSTRAINT IF EXISTS "${swap}"`,
            );
            await queryRunner.query(
                `ALTER TABLE "${fk.table}" ADD CONSTRAINT "${swap}" FOREIGN KEY ("${fk.column}") REFERENCES "users"("uuid") ON DELETE ${onDelete} ON UPDATE NO ACTION NOT VALID`,
            );
            await queryRunner.query(
                `ALTER TABLE "${fk.table}" DROP CONSTRAINT IF EXISTS "${fk.name}"`,
            );
        }
        await queryRunner.query(
            `ALTER TABLE "${fk.table}" RENAME CONSTRAINT "${swap}" TO "${fk.name}"`,
        );
        await queryRunner.query(
            `ALTER TABLE "${fk.table}" VALIDATE CONSTRAINT "${fk.name}"`,
        );
    }
}
