import { LockScopedPg } from '../persistence/lock-scoped-pg';
import { PgCommandStore } from '../persistence/pg-command-store';
import { PgAdmissionStore } from './pg-admission-store';
import { PgPhysicalAdmissionDirectory } from './physical-admission-directory';
import { RuntimeCommandConsumer } from '../../worker/consumer/run-request.consumer';
import { RuntimeRunRetry } from '../../worker/consumer/runtime-run-retry';
import { PgDistributedLocks } from '../persistence/locks';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { shopRunRequest } from '../../e2e/fixtures';
import { RuntimeEventName } from '@libs/runtime/run';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PgPrAdmissionStore } from './pr-admission-store';
import { ensureRuntimeSchema } from '../persistence/runtime-schema';
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
(!url || process.env.SKIP_INTEGRATION === 'true' ? describe.skip : describe)(
    'PR generation authority (real Postgres)',
    () => {
        let first: Pool, second: Pool;
        const organizationId = `pr-fence-it-${randomUUID()}`;
        const scope = { organizationId, repositoryId: 'repo', prNumber: 1 };
        beforeAll(async () => {
            first = new Pool({ connectionString: url, max: 4 });
            second = new Pool({ connectionString: url, max: 4 });
            await ensureRuntimeSchema(first);
        });
        afterAll(async () => {
            for (const table of [
                'runtime_pr_run_generations',
                'runtime_pr_cancel_generations',
                'runtime_pr_fences',
                'runtime_admission_requests',
            ]) {
                const orgColumn =
                    table === 'runtime_admission_requests'
                        ? 'org_id'
                        : 'organization_id';
                await first.query(
                    `DELETE FROM runtime.${table} WHERE ${orgColumn}=ANY($1::text[])`,
                    [[organizationId, `${organizationId}-other`]],
                );
            }
            await Promise.all([first.end(), second.end()]);
        });
        it('persists old Run and cancel fences across separate pools and fresh store instances', async () => {
            await new PgPrAdmissionStore(first).register(
                scope,
                'a',
                'old',
                false,
            );
            const cancelled = await new PgPrAdmissionStore(second).cancel(
                scope,
                'close',
            );
            await new PgPrAdmissionStore(first).register(
                scope,
                'b',
                'new',
                false,
            );
            const recovered = new PgPrAdmissionStore(second);
            expect(await recovered.register(scope, 'a', 'old', true)).toEqual({
                accepted: false,
                reason: 'superseded',
            });
            expect(await recovered.cancel(scope, 'close')).toBe(cancelled);
            expect(await recovered.canCancel(scope, 'b', cancelled)).toBe(
                false,
            );
            expect(await recovered.canCancel(scope, 'a', cancelled)).toBe(true);
            expect(await recovered.current(scope, 'b')).toEqual({
                accepted: true,
            });
        });
        it('serializes competing first admissions and keeps unknown redeliveries fail-closed', async () => {
            const concurrent = { ...scope, prNumber: 2 };
            const [a, b] = [
                new PgPrAdmissionStore(first),
                new PgPrAdmissionStore(second),
            ];
            await Promise.all([
                a.register(concurrent, 'c', 'c', false),
                b.register(concurrent, 'd', 'd', false),
            ]);
            const statuses = await Promise.all([
                a.current(concurrent, 'c'),
                b.current(concurrent, 'd'),
            ]);
            expect(statuses.filter((s) => s.accepted)).toHaveLength(1);
            expect(
                await a.register(concurrent, 'unknown', 'unknown', true),
            ).toEqual({ accepted: false, reason: 'unknown_redelivery' });
        });
        it('isolates identities across orgs and rejects a runId or cancelId rebound to another repo', async () => {
            const store = new PgPrAdmissionStore(first);
            await expect(
                store.register(
                    { ...scope, repositoryId: 'other' },
                    'a',
                    'old',
                    false,
                ),
            ).rejects.toMatchObject({ code: 'admission_conflict' });
            await expect(
                store.cancel({ ...scope, repositoryId: 'other' }, 'close'),
            ).rejects.toMatchObject({ code: 'admission_conflict' });
            const other = {
                ...scope,
                organizationId: `${organizationId}-other`,
            };
            expect(
                await store.register(other, 'a', 'independent', false),
            ).toEqual({ accepted: true });
            expect(await store.current(other, 'a')).toEqual({ accepted: true });
            expect(await store.current(scope, 'b')).toEqual({ accepted: true });
        });
        it.each(['new-head', 'pr-closed'])(
            'real consumer retries stay fenced across worker pools after %s',
            async (scenario) => {
                const projection = new InMemoryRunProjectionStore();
                const setups = { get: jest.fn(async () => null) };
                const engine = {
                    start: jest.fn(async (_req: unknown) => undefined),
                    stop: jest.fn(async () => undefined),
                };
                const consumer = (pool: Pool) => {
                    const locks = new PgDistributedLocks(pool),
                        sql = new LockScopedPg(pool, locks);
                    return new RuntimeCommandConsumer(
                        engine as any,
                        projection,
                        new PgCommandStore(pool, sql),
                        new PgPrAdmissionStore(pool, sql),
                        undefined,
                        setups,
                        locks,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        new RuntimeRunRetry(
                            { publish: jest.fn() },
                            { maxRetries: 2, delayMs: 100, maxDelayMs: 1000 },
                        ),
                    );
                };
                const a = shopRunRequest({
                    organizationId,
                    pullRequest: {
                        ...shopRunRequest().pullRequest,
                        number: scenario === 'new-head' ? 3 : 4,
                    },
                });
                const b = {
                    ...a,
                    runId: randomUUID(),
                    pullRequest: { ...a.pullRequest, headSha: 'c'.repeat(40) },
                };
                const raw = (messageId: string, count = 0) =>
                    ({
                        content: Buffer.from('{}'),
                        properties: {
                            messageId,
                            headers: { 'x-retry-count': count },
                        },
                        fields: {
                            routingKey: 'workflow.jobs.created.RUNTIME_RUN',
                            redelivered: false,
                        },
                    }) as unknown as ConsumeMessage;
                const run = (payload: unknown) => ({
                    event_name: RuntimeEventName.RunRequested,
                    payload,
                });
                setups.get.mockRejectedValueOnce(
                    new Error('fixture_setup_unavailable'),
                );
                await expect(
                    consumer(first).onMessage(run(a), raw(a.runId)),
                ).rejects.toThrow();
                if (scenario === 'new-head')
                    await consumer(second).onMessage(run(b), raw(b.runId));
                else
                    await consumer(second).onMessage(
                        {
                            event_name: RuntimeEventName.RunCancelRequested,
                            payload: {
                                organizationId,
                                repositoryId: a.repository.id,
                                prNumber: a.pullRequest.number,
                                reason: 'pr_closed',
                            },
                        },
                        raw(randomUUID()),
                    );
                await consumer(first).onMessage(run(a), raw(a.runId, 1));
                expect(
                    engine.start.mock.calls.map(
                        (c) => (c[0] as { runId: string }).runId,
                    ),
                ).toEqual(scenario === 'new-head' ? [b.runId] : []);
                expect(engine.stop).not.toHaveBeenCalled();
                expect(
                    (await projection.get(a.runId, { organizationId }))?.state,
                ).toBe(scenario === 'new-head' ? 'superseded' : 'cancelled');
            },
        );

        it('registry, command read, durable admission and physical release finish inside a PR lock with max1 pool', async () => {
            const pool = new Pool({
                connectionString: url,
                max: 1,
                connectionTimeoutMillis: 500,
            });
            const locks = new PgDistributedLocks(pool),
                sql = new LockScopedPg(pool, locks);
            const registry = new PgPrAdmissionStore(pool, sql),
                commands = new PgCommandStore(pool, sql),
                admission = new PgAdmissionStore(pool, sql);
            const physical = new PgPhysicalAdmissionDirectory(sql, {
                inTransaction: (fn) => sql.transaction(fn),
            });
            const request = shopRunRequest({ organizationId });
            const pr = {
                organizationId,
                repositoryId: request.repository.id,
                prNumber: 5,
            };
            try {
                await locks.withLock(`fixture:${organizationId}`, async () => {
                    expect(
                        await registry.register(
                            pr,
                            request.runId,
                            request.pullRequest.headSha,
                            false,
                        ),
                    ).toEqual({ accepted: true });
                    expect(await registry.current(pr, request.runId)).toEqual({
                        accepted: true,
                    });
                    expect(await commands.isStopped(organizationId)).toBe(
                        false,
                    );
                    const accepted = await admission.accept(
                        { kind: 'run', request },
                        {
                            globalWaiting: 50,
                            perOrgWaiting: 30,
                            globalExecuting: 3,
                            perOrgExecuting: 2,
                            maxAttempts: 3,
                        },
                    );
                    expect(accepted.status).toBe('accepted');
                    expect(
                        await admission.get({
                            organizationId,
                            kind: 'run',
                            key: request.runId,
                        }),
                    ).not.toBeNull();
                    await physical.release({
                        organizationId,
                        kind: 'run',
                        key: request.runId,
                        generation: 1,
                        ticketOwnerToken: randomUUID(),
                        ticketId: randomUUID(),
                        cellId: 'absent-fixture-cell',
                        sessionEpoch: randomUUID(),
                        expiresAt: new Date().toISOString(),
                        members: [],
                    });
                    expect(pool.totalCount).toBe(1);
                    expect(pool.waitingCount).toBe(0);
                });
            } finally {
                await pool.end();
            }
        });
    },
);
