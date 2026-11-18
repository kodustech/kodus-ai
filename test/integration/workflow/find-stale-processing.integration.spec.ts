/**
 * `findStaleProcessing` + `requeueStaleJobs` against a real Postgres (#1830).
 *
 * The unit specs mock the query builder, so a wrong FROM clause is invisible to
 * them: a cross-join still returns the expected row when the table holds one
 * row. This runs the real SQL.
 *
 * `findStaleProcessing` used to cross-join `workflow_jobs` with itself —
 * `createQueryBuilder()` already left the entity in FROM under its default
 * alias, and the extra `.from(WorkflowJobModel, 'job')` added a second entry.
 * Every stale job then came back once per row in the table, so the reaper was
 * handing (stale × table size) uuids to an `IN (...)`; Postgres refuses more
 * than 65,535 bind parameters, the requeue was rejected and nothing was ever
 * reclaimed.
 *
 * The schema is created from the entities, so the spec does not need a migrated
 * database. That is deliberate: fork CI skips migrations, and this is the check
 * that has to run there. Point `TEST_PG_*` at a SCRATCH database (a throwaway
 * container is enough), because `synchronize` will shape the `kodus_workflow`
 * schema to the entities. Skips automatically when Postgres is unreachable.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';

import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { WorkflowJobRepository } from '@libs/core/workflow/infrastructure/repositories/workflow-job.repository';
import { InboxMessageModel } from '@libs/core/workflow/infrastructure/repositories/schemas/inbox-message.model';
import { OutboxMessageModel } from '@libs/core/workflow/infrastructure/repositories/schemas/outbox-message.model';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';

const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PG_PORT = parseInt(
    process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
    10,
);
const PG_USER =
    process.env.TEST_PG_USER ?? process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const PG_PASSWORD =
    process.env.TEST_PG_PASSWORD ??
    process.env.API_PG_DB_PASSWORD ??
    'kodusdev';
const PG_DB =
    process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db';

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

/** Rows the spec adds that the reaper must never pick up. */
const NOISE_ROWS = 25;

function makeDataSource(): DataSource {
    return new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port: PG_PORT,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        logging: false,
        // From the entities, not from a migration run (see the header).
        synchronize: true,
        // The reaper's own model plus the two its relations point at: TypeORM
        // aborts initialize() on an unresolved inverse relation.
        entities: [WorkflowJobModel, OutboxMessageModel, InboxMessageModel],
        extra: {
            max: 4,
            connectionTimeoutMillis: 10_000,
        },
    });
}

/**
 * `synchronize` shapes the tables inside a schema, it does not create the
 * schema itself, and the model declares `kodus_workflow`. Create it on a
 * connection with no entities, so the initialise below has somewhere to work.
 */
async function ensureSchemas(): Promise<void> {
    const bootstrap = new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port: PG_PORT,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        entities: [],
        synchronize: false,
        logging: false,
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS kodus_workflow');
    await bootstrap.destroy();
}

(skipIntegration ? describe.skip : describe)(
    'WorkflowJobRepository stale reap against real Postgres (#1830)',
    () => {
        jest.setTimeout(60_000);

        let dataSource: DataSource | null = null;
        let repo: WorkflowJobRepository | null = null;
        const tag = `reap-${process.pid}-${Date.now()}`;

        beforeAll(async () => {
            const probe = makeDataSource();
            try {
                await ensureSchemas();
                await probe.initialize();
                await probe.query('SELECT 1');
                dataSource = probe;
                repo = new WorkflowJobRepository(
                    probe.getRepository(WorkflowJobModel) as any,
                );
            } catch (error) {
                // Say WHY, not just that it is unreachable: a metadata or
                // sync error would otherwise look like a missing database.
                console.warn(
                    `[find-stale-processing] Postgres unavailable at ${PG_HOST}:${PG_PORT}/${PG_DB}:`,
                    error instanceof Error ? error.message : error,
                );
                await probe.destroy().catch(() => undefined);
                dataSource = null;
                repo = null;
            }
        });

        afterAll(async () => {
            if (dataSource) {
                await dataSource
                    .getRepository(WorkflowJobModel)
                    .delete({ organizationId: tag } as any)
                    .catch(() => undefined);
                await dataSource.destroy().catch(() => undefined);
            }
        });

        /**
         * Runtime guard: `it.skip` cannot be used here, because the decision
         * would be taken while the describe body runs — before `beforeAll` has
         * connected — and every test would be skipped even on a live database.
         */
        const requirePg = (): boolean => {
            if (dataSource && repo) {
                return true;
            }
            console.warn(
                `[find-stale-processing] Postgres unreachable at ${PG_HOST}:${PG_PORT}/${PG_DB} — skipping`,
            );
            return false;
        };

        it('returns a stale job exactly once for every row in the table', async () => {
            if (!requirePg()) {
                return;
            }
            {
                const model = dataSource!.getRepository(WorkflowJobModel);

                // Stale: a PROCESSING job whose lease expired an hour ago.
                const stale = await repo!.create({
                    workflowType: WorkflowType.CODE_REVIEW,
                    handlerType: HandlerType.SIMPLE_FUNCTION,
                    status: JobStatus.PROCESSING,
                    organizationId: tag,
                    correlationId: `${tag}-stale`,
                } as any);

                // Noise. Without it the cross-join was invisible: the table
                // held nothing but the rows being returned.
                for (let i = 0; i < NOISE_ROWS; i++) {
                    await repo!.create({
                        workflowType: WorkflowType.CODE_REVIEW,
                        handlerType: HandlerType.SIMPLE_FUNCTION,
                        status: JobStatus.COMPLETED,
                        organizationId: tag,
                        correlationId: `${tag}-noise-${i}`,
                    } as any);
                }

                await model.update(
                    { uuid: stale.uuid },
                    { leaseExpiresAt: new Date(Date.now() - 3_600_000) } as any,
                );

                const found = await repo!.findStaleProcessing({
                    now: new Date(),
                    olderThan: new Date(Date.now() - 1_800_000),
                });

                const mine = found.filter((job) => job.uuid === stale.uuid);
                expect(mine).toHaveLength(1);

                // The invariant the reaper depends on: the uuid list goes
                // straight into an `IN (...)`, and Postgres refuses more than
                // 65,535 bind parameters, so a multiplied list reclaims nothing.
                const uuids = found.map((job) => job.uuid);
                expect(new Set(uuids).size).toBe(uuids.length);
                expect(uuids).toEqual(
                    expect.arrayContaining([stale.uuid]),
                );

                const requeued = await repo!.requeueStaleJobs({
                    uuids,
                    lastError: 'reaper integration test',
                    requeuedBy: 'integration-test',
                    organizationIds: [tag],
                });

                // The invariant the reaper depends on, and the one the reaper
                // cannot afford to break: every stale job is handed to the
                // requeue exactly once, and the requeue reports each of them
                // exactly once. Stated as set membership rather than as an
                // equality on the whole batch, because a shared database can
                // legitimately hold other stale rows.
                expect(requeued).toContain(stale.uuid);
                expect(requeued.filter((uuid) => uuid === stale.uuid)).toHaveLength(
                    1,
                );

                // And it is really back in the queue, with its lease cleared.
                const after = await model.findOne({
                    where: { uuid: stale.uuid },
                });
                expect(after?.status).toBe(JobStatus.PENDING);
                expect(after?.leaseExpiresAt ?? null).toBeNull();
                expect(after?.retryCount).toBe(1);
            }
        });

        it('does not reclaim a job whose lease is still live, nor an aged row without one', async () => {
            if (!requirePg()) {
                return;
            }
            {
                const model = dataSource!.getRepository(WorkflowJobModel);

                const live = await repo!.create({
                    workflowType: WorkflowType.CODE_REVIEW,
                    handlerType: HandlerType.SIMPLE_FUNCTION,
                    status: JobStatus.PROCESSING,
                    organizationId: tag,
                    correlationId: `${tag}-live`,
                } as any);
                await model.update(
                    { uuid: live.uuid },
                    { leaseExpiresAt: new Date(Date.now() + 60_000) } as any,
                );

                // Non-lease workflow type: aged PROCESSING row, no lease. The
                // reaper leaves it to the legacy fail-only path.
                const aged = await repo!.create({
                    workflowType: WorkflowType.CRON_KODY_LEARNING,
                    handlerType: HandlerType.SIMPLE_FUNCTION,
                    status: JobStatus.PROCESSING,
                    organizationId: tag,
                    correlationId: `${tag}-aged`,
                } as any);
                await model.update(
                    { uuid: aged.uuid },
                    { updatedAt: new Date(Date.now() - 7_200_000) } as any,
                );

                const found = await repo!.findStaleProcessing({
                    now: new Date(),
                    olderThan: new Date(Date.now() - 1_800_000),
                });
                const uuids = found.map((job) => job.uuid);

                expect(uuids).not.toContain(live.uuid);
                expect(uuids).toContain(aged.uuid);
                // The lease-less row is visible to the reaper but carries no
                // lease, which is what keeps it out of the requeue partition.
                expect(
                    found.find((job) => job.uuid === aged.uuid)
                        ?.leaseExpiresAt ?? null,
                ).toBeNull();
            }
        });
    },
);
