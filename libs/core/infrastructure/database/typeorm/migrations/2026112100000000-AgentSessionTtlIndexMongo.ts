import { MigrationInterface, QueryRunner } from 'typeorm';

import { AGENT_SESSION_TTL_SECONDS } from '@libs/agents/infrastructure/persistence/schemas/agent-session.model';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';

/**
 * MongoDB migration (TypeORM runner — Postgres ledger, once per instance, on
 * boot). Builds `ttl_updatedAt` on `kodus-agent-sessions`, the TTL that
 * expires a conversation 30 days after its last message. The schema declares
 * it too, but schema indexes are built only while MONGO_AUTO_INDEX is on;
 * here it exists either way. createIndex with the same key and options is a
 * no-op when the index is already there.
 */
export class AgentSessionTtlIndexMongo2026112100000000 implements MigrationInterface {
    name = 'AgentSessionTtlIndexMongo2026112100000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[AgentSessionTtlIndexMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const { db, close } = await mongoMigrationClient();
        try {
            await db
                .collection('kodus-agent-sessions')
                .createIndex(
                    { updatedAt: 1 },
                    {
                        name: 'ttl_updatedAt',
                        expireAfterSeconds: AGENT_SESSION_TTL_SECONDS,
                    },
                );
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) return;
        const { db, close } = await mongoMigrationClient();
        try {
            await db
                .collection('kodus-agent-sessions')
                .dropIndex('ttl_updatedAt')
                .catch(() => undefined);
        } finally {
            await close();
        }
    }
}
