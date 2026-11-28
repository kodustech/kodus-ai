/**
 * INTEGRATION TEST — OutboxMessageRepository.createMany against a real
 * Postgres. Mocks cannot show what the database stores: the pre-generated
 * uuid, the JSONB `payload.messageId`, the READY default, or that the batch
 * commits inside the caller's transaction (which the stale-job reaper relies
 * on). Skips if Postgres isn't reachable, like the retention spec.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';

import { OutboxMessageRepository } from './outbox-message.repository';
import {
    OutboxMessageModel,
    OutboxStatus,
} from './schemas/outbox-message.model';
import { InboxMessageModel } from './schemas/inbox-message.model';
import { WorkflowJobModel } from './schemas/workflow-job.model';

const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: parseInt(
        process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
        10,
    ),
    username:
        process.env.TEST_PG_USER ??
        process.env.API_PG_DB_USERNAME ??
        'kodusdev',
    password:
        process.env.TEST_PG_PASSWORD ??
        process.env.API_PG_DB_PASSWORD ??
        'kodusdev',
    database:
        process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db',
    logging: false,
    synchronize: false,
    entities: [InboxMessageModel, OutboxMessageModel, WorkflowJobModel],
});

const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);
const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

(skipIntegration ? describe.skip : describe)(
    'OutboxMessageRepository.createMany (integration, real Postgres)',
    () => {
        let canRun = true;
        let repository: OutboxMessageRepository;
        const marker = `outbox-it-${process.pid}-${Date.now()}`;

        const reload = async (uuids: string[]) =>
            dataSource.query(
                `SELECT "uuid", "payload", "status", "nextAttemptAt", "exchange"
                   FROM "kodus_workflow"."outbox_messages"
                  WHERE "uuid" = ANY($1)`,
                [uuids],
            );

        beforeAll(async () => {
            try {
                await dataSource.initialize();
            } catch (error) {
                if (!UNREACHABLE.has((error as { code?: string })?.code)) {
                    throw error;
                }
                canRun = false;
                return;
            }
            repository = new OutboxMessageRepository(
                dataSource.getRepository(OutboxMessageModel),
            );
        });

        afterAll(async () => {
            if (dataSource.isInitialized) {
                await dataSource.query(
                    `DELETE FROM "kodus_workflow"."outbox_messages" WHERE "routingKey" = $1`,
                    [marker],
                );
                await dataSource.destroy();
            }
        });

        it('writes the batch once and reloads the fields it promises', async () => {
            if (!canRun) return;

            const explicit = `00000000-0000-4000-8000-${Date.now()
                .toString()
                .padStart(12, '0')
                .slice(-12)}`;
            const nextAttemptAt = new Date('2030-01-01T00:00:00Z');

            await repository.createMany([
                {
                    uuid: explicit,
                    exchange: 'kodus.workflow',
                    routingKey: marker,
                    payload: { jobId: 'job-1' },
                },
                {
                    exchange: 'kodus.workflow',
                    routingKey: marker,
                    payload: { jobId: 'job-2' },
                    nextAttemptAt,
                },
            ]);

            const rows = await reload([explicit]);
            expect(rows).toHaveLength(1);
            expect(rows[0].uuid).toBe(explicit);
            expect(rows[0].payload.messageId).toBe(explicit);
            expect(rows[0].status).toBe(OutboxStatus.READY);

            const generated = await dataSource.query(
                `SELECT "uuid", "payload", "status", "nextAttemptAt"
                   FROM "kodus_workflow"."outbox_messages"
                  WHERE "routingKey" = $1 AND "uuid" <> $2`,
                [marker, explicit],
            );
            expect(generated).toHaveLength(1);
            expect(generated[0].uuid).toBeTruthy();
            expect(generated[0].payload.messageId).toBe(generated[0].uuid);
            expect(new Date(generated[0].nextAttemptAt).toISOString()).toBe(
                nextAttemptAt.toISOString(),
            );
        });

        it('commits with the caller transaction and rolls back with it', async () => {
            if (!canRun) return;

            const manager = dataSource.manager;
            const rolledBack = await manager
                .transaction(async (tx) => {
                    const [row] = await repository.createMany(
                        [
                            {
                                exchange: 'kodus.workflow',
                                routingKey: marker,
                                payload: { jobId: 'rollback' },
                            },
                        ],
                        tx,
                    );
                    // Visible inside the transaction...
                    const inside = await tx
                        .getRepository(OutboxMessageModel)
                        .findOneBy({ uuid: row.uuid });
                    expect(inside).not.toBeNull();
                    // ...and thrown away with it.
                    throw new Error('rollback');
                })
                .catch((error) => error.message);
            expect(rolledBack).toBe('rollback');

            const orphan = await dataSource.query(
                `SELECT "uuid" FROM "kodus_workflow"."outbox_messages"
                  WHERE "routingKey" = $1 AND "payload"->>'jobId' = 'rollback'`,
                [marker],
            );
            expect(orphan).toHaveLength(0);
        });
    },
);
