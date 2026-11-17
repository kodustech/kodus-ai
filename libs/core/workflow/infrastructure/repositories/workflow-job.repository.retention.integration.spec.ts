/**
 * INTEGRATION TEST — WorkflowJobRepository.deleteFinishedOlderThan against a
 * real Postgres: the inbox/outbox foreign keys are ON DELETE NO ACTION, so
 * only the database proves a referenced job is left alone. Skips if
 * Postgres isn't reachable, like distributed-lock.service.integration.spec.ts.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';

import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';

import { WorkflowJobRepository } from './workflow-job.repository';
import { InboxMessageModel } from './schemas/inbox-message.model';
import { OutboxMessageModel } from './schemas/outbox-message.model';
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
    'WorkflowJobRepository.deleteFinishedOlderThan (integration, real Postgres)',
    () => {
        let canRun = true;
        let repository: WorkflowJobRepository;
        // Unique per run, so the cutoff below only ever sees this test's rows.
        const marker = `retention-it-${process.pid}-${Date.now()}`;
        const longAgo = new Date('2001-01-01T00:00:00Z');
        const cutoff = new Date('2001-02-01T00:00:00Z');

        const insertJob = async (
            status: JobStatus,
            updatedAt: Date | string,
            workflowType: WorkflowType = WorkflowType.WEBHOOK_PROCESSING,
        ) => {
            const [row] = await dataSource.query(
                `INSERT INTO "kodus_workflow"."workflow_jobs"
                    ("correlationId", "workflowType", "handlerType", "status", "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $5) RETURNING "uuid"`,
                [
                    marker,
                    workflowType,
                    Object.values(HandlerType)[0],
                    status,
                    updatedAt,
                ],
            );
            return row.uuid as string;
        };

        const remaining = async () =>
            (
                await dataSource.query(
                    `SELECT "uuid" FROM "kodus_workflow"."workflow_jobs" WHERE "correlationId" = $1`,
                    [marker],
                )
            ).map((r: { uuid: string }) => r.uuid);

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
            repository = new WorkflowJobRepository(
                dataSource.getRepository(WorkflowJobModel),
            );
        });

        afterAll(async () => {
            if (dataSource.isInitialized) {
                await dataSource.query(
                    `DELETE FROM "kodus_workflow"."inbox_messages" WHERE "messageId" = $1`,
                    [marker],
                );
                await dataSource.query(
                    `DELETE FROM "kodus_workflow"."outbox_messages" WHERE "routingKey" = $1`,
                    [marker],
                );
                await dataSource.query(
                    `DELETE FROM "kodus_workflow"."workflow_jobs" WHERE "correlationId" = $1`,
                    [marker],
                );
                await dataSource.destroy();
            }
        });

        it('deletes only finished jobs past the cutoff that no message still points to and whose type is not kept', async () => {
            if (!canRun) return;

            const completedOld = await insertJob(JobStatus.COMPLETED, longAgo);
            const failedOld = await insertJob(JobStatus.FAILED, longAgo);
            const pendingOld = await insertJob(JobStatus.PENDING, longAgo);
            const completedRecent = await insertJob(
                JobStatus.COMPLETED,
                new Date(),
            );
            const heldByInbox = await insertJob(JobStatus.FAILED, longAgo);
            const heldByOutbox = await insertJob(JobStatus.COMPLETED, longAgo);
            // try.kodus.io share links read the CLI review job row.
            const cliReview = await insertJob(
                JobStatus.COMPLETED,
                longAgo,
                WorkflowType.CLI_CODE_REVIEW,
            );

            await dataSource.query(
                `INSERT INTO "kodus_workflow"."inbox_messages" ("messageId", "job_id") VALUES ($1, $2)`,
                [marker, heldByInbox],
            );
            await dataSource.query(
                `INSERT INTO "kodus_workflow"."outbox_messages" ("exchange", "routingKey", "payload", "job_id")
                 VALUES ('x', $1, '{}'::jsonb, $2)`,
                [marker, heldByOutbox],
            );

            const { deleted } = await repository.deleteFinishedOlderThan({
                olderThan: cutoff,
                batchSize: 100,
                keepWorkflowTypes: [WorkflowType.CLI_CODE_REVIEW],
            });

            expect(deleted).toBe(2);
            expect((await remaining()).sort()).toEqual(
                [
                    pendingOld,
                    completedRecent,
                    heldByInbox,
                    heldByOutbox,
                    cliReview,
                ].sort(),
            );
            expect(await remaining()).not.toEqual(
                expect.arrayContaining([completedOld, failedOld]),
            );
        });

        it('deletes no more than one batch per call', async () => {
            if (!canRun) return;

            await insertJob(JobStatus.COMPLETED, longAgo);
            await insertJob(JobStatus.COMPLETED, longAgo);
            await insertJob(JobStatus.COMPLETED, longAgo);

            await expect(
                repository.deleteFinishedOlderThan({
                    olderThan: cutoff,
                    batchSize: 2,
                }),
            ).resolves.toEqual(expect.objectContaining({ deleted: 2 }));
        });

        it('resumes after the point a previous batch reached, leaving older rows to their own pass', async () => {
            if (!canRun) return;

            const before = await insertJob(
                JobStatus.COMPLETED,
                '2001-01-10 00:00:00',
            );
            const after = await insertJob(
                JobStatus.COMPLETED,
                '2001-01-20 00:00:00',
            );

            const batch = await repository.deleteFinishedOlderThan({
                olderThan: cutoff,
                batchSize: 100,
                after: '2001-01-15 00:00:00',
            });

            expect(batch).toEqual({
                deleted: 1,
                lastUpdatedAt: '2001-01-20 00:00:00',
            });
            expect(await remaining()).toEqual(expect.arrayContaining([before]));
            expect(await remaining()).not.toContain(after);
        });
    },
);
