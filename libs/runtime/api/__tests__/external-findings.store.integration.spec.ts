import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { Pool } from 'pg';
import { CreateRuntimeExternalFindings2026110800000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026110800000000-CreateRuntimeExternalFindings';
import { ExternalFindingLifecycle2026110800000001 } from '@libs/core/infrastructure/database/typeorm/migrations/2026110800000001-ExternalFindingLifecycle';
import { TypeOrmExternalFindingsStore } from '../infrastructure/typeorm-external-findings.store';
import { externalFindingsFixture } from './fixtures/external-findings.fixture';

// Explicit opt-in only. A unique generated schema owns every fixture table.
const url = process.env.EXTERNAL_FINDINGS_IT_DATABASE_URL;
(url ? describe : describe.skip)(
    'PostgreSQL durable external admission transaction',
    () => {
        const schema = `external_findings_it_${process.pid}_${randomUUID().replaceAll('-', '')}`;
        let admin: Pool;
        let source: DataSource;
        let failing = false;
        const outbox = {
            create: async (message: unknown, manager: unknown) => {
                await (manager as EntityManager).query(
                    'INSERT INTO fixture_external_outbox(payload) VALUES($1::jsonb)',
                    [JSON.stringify(message)],
                );
                if (failing) throw new Error('fixture outbox failure');
            },
        };
        const store = () => new TypeOrmExternalFindingsStore(source, outbox);
        beforeAll(async () => {
            admin = new Pool({ connectionString: url, max: 1 });
            await admin.query(`CREATE SCHEMA "${schema}"`);
            source = new DataSource({
                type: 'postgres',
                url,
                extra: { options: `-c search_path=${schema}`, max: 4 },
                entities: [],
                synchronize: false,
            });
            await source.initialize();
            const migration =
                new CreateRuntimeExternalFindings2026110800000000();
            const runner = source.createQueryRunner();
            try {
                await migration.up(runner);
                await new ExternalFindingLifecycle2026110800000001().up(runner);
            } finally {
                await runner.release();
            }
            await source.query(
                'CREATE TABLE fixture_external_outbox(id bigserial PRIMARY KEY,payload jsonb NOT NULL)',
            );
        });
        afterAll(async () => {
            await source?.destroy();
            if (admin) {
                await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
                await admin.end();
            }
        });
        afterEach(async () => {
            failing = false;
            await source.query(
                'TRUNCATE runtime_external_message_keys,runtime_external_submissions,fixture_external_outbox',
            );
        });
        async function input() {
            const h = externalFindingsFixture();
            await h.service.submit(h.principal, h.input, 'message');
            return {
                record: h.store.records[0],
                request: h.store.requests[0],
                messageId: 'message',
                bodyHash: 'a'.repeat(64),
                at: h.now().toISOString(),
            };
        }
        it('survives reconstruction and atomically deduplicates concurrent admission', async () => {
            const admitted = await input();
            const responses = await Promise.all([
                store().admit(admitted),
                store().admit(admitted),
            ]);
            expect(responses.map((r) => r.deduplicated).sort()).toEqual([
                false,
                true,
            ]);
            expect(
                (
                    await source.query(
                        'SELECT count(*)::int AS n FROM runtime_external_submissions',
                    )
                )[0].n,
            ).toBe(1);
            expect(
                (
                    await source.query(
                        'SELECT count(*)::int AS n FROM fixture_external_outbox',
                    )
                )[0].n,
            ).toBe(1);
            expect(
                (
                    await store().byTask(
                        admitted.record.organizationId,
                        admitted.record.verificationTaskId,
                    )
                )?.receiptId,
            ).toBe(admitted.record.receiptId);
            const alias = await store().admit({
                ...admitted,
                messageId: 'another-message',
                request: undefined,
            });
            expect(alias.deduplicated).toBe(true);
            expect(
                (
                    await source.query(
                        'SELECT count(*)::int AS n FROM fixture_external_outbox',
                    )
                )[0].n,
            ).toBe(1);
            expect(
                await store().byTask(
                    'foreign-org',
                    admitted.record.verificationTaskId,
                ),
            ).toBeNull();
        });
        it('rolls receipt, task, alias and outbox back together on publication failure', async () => {
            const admitted = await input();
            failing = true;
            await expect(store().admit(admitted)).rejects.toThrow(
                'fixture outbox failure',
            );
            for (const table of [
                'runtime_external_submissions',
                'runtime_external_message_keys',
                'fixture_external_outbox',
            ]) {
                expect(
                    (
                        await source.query(
                            `SELECT count(*)::int AS n FROM ${table}`,
                        )
                    )[0].n,
                ).toBe(0);
            }
        });
        it('persists a terminal outcome once and scopes all later reads', async () => {
            const admitted = await input();
            await store().admit(admitted);
            const terminal = {
                state: 'failed' as const,
                result: { reason: 'fixture' },
                updatedAt: admitted.record.createdAt,
            };
            await store().complete(
                admitted.record.organizationId,
                admitted.record.verificationTaskId,
                terminal,
            );
            await store().complete(
                admitted.record.organizationId,
                admitted.record.verificationTaskId,
                { ...terminal, result: { reason: 'replacement' } },
            );
            expect(
                (
                    await store().byTask(
                        admitted.record.organizationId,
                        admitted.record.verificationTaskId,
                    )
                )?.terminal,
            ).toEqual(terminal);
            expect(
                await store().byFinding(
                    'foreign-org',
                    admitted.record.findingIds[0],
                ),
            ).toBeNull();
            expect(
                await store().byMessage(
                    'foreign-org',
                    admitted.record.keyId,
                    'message',
                ),
            ).toBeNull();
        });
        it('checks indexed daily quotas before new writes and leaves prior data intact', async () => {
            const admitted = await input();
            for (let i = 0; i < 100; i++) {
                const r = {
                    ...admitted.record,
                    receiptId: randomUUID(),
                    verificationTaskId: randomUUID(),
                    fingerprint: String(i).padStart(64, '0'),
                };
                await source.query(
                    'INSERT INTO runtime_external_submissions(receipt_id,verification_task_id,organization_id,key_id,repository_id,pr_number,fingerprint,finding_ids,finding_count,created_at,record,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,10,$9,$10::jsonb,$11)',
                    [
                        r.receiptId,
                        r.verificationTaskId,
                        r.organizationId,
                        r.keyId,
                        r.repositoryId,
                        r.prNumber,
                        r.fingerprint,
                        r.findingIds,
                        r.createdAt,
                        JSON.stringify(r),
                        r.expiresAt,
                    ],
                );
            }
            expect(
                await store().quotaAvailable(
                    admitted.record.organizationId,
                    admitted.record.keyId,
                    admitted.record.repositoryId,
                    admitted.record.prNumber,
                    admitted.record.createdAt,
                    1,
                ),
            ).toBe(false);
            await expect(store().admit(admitted)).rejects.toMatchObject({
                code: 'quota_exceeded',
            });
            expect(
                (
                    await source.query(
                        'SELECT count(*)::int AS n FROM fixture_external_outbox',
                    )
                )[0].n,
            ).toBe(0);
        });
        it('bounds duplicate aliases using current admission day, without charging exact retries', async () => {
            const admitted = await input();
            await store().admit(admitted);
            await source.query(
                `INSERT INTO runtime_external_message_keys(organization_id,key_id,message_id,body_hash,receipt_id,created_at) SELECT $1,$2,'alias-'||n,$3,$4,$5 FROM generate_series(1,3999) n`,
                [
                    admitted.record.organizationId,
                    admitted.record.keyId,
                    admitted.bodyHash,
                    admitted.record.receiptId,
                    admitted.at,
                ],
            );
            await expect(
                store().admit({
                    ...admitted,
                    messageId: 'one-more',
                    request: undefined,
                }),
            ).rejects.toMatchObject({ code: 'message_quota_exceeded' });
            expect((await store().admit(admitted)).deduplicated).toBe(true);
            expect(
                (
                    await source.query(
                        'SELECT count(*)::int AS n FROM fixture_external_outbox',
                    )
                )[0].n,
            ).toBe(1);
        });
        it('lists only expired pending tasks of the requested organization with bounded indexes', async () => {
            const admitted = await input();
            await store().admit(admitted);
            const foreign = structuredClone(admitted);
            foreign.record.receiptId = randomUUID();
            foreign.record.verificationTaskId = randomUUID();
            foreign.record.organizationId = 'org-foreign';
            foreign.record.fingerprint = 'f'.repeat(64);
            foreign.record.refusal = 'execution_probe_required';
            delete foreign.record.runId;
            foreign.request = undefined;
            await store().admit(foreign);
            expect(
                await store().listExpiredTaskIds(
                    admitted.record.organizationId,
                    admitted.record.expiresAt,
                    1,
                ),
            ).toEqual([admitted.record.verificationTaskId]);
            expect(
                await store().listExpiredTaskIds(
                    'org-absent',
                    admitted.record.expiresAt,
                    1,
                ),
            ).toEqual([]);
            await store().complete(
                admitted.record.organizationId,
                admitted.record.verificationTaskId,
                { state: 'failed', result: {}, updatedAt: admitted.at },
            );
            expect(
                await store().listExpiredTaskIds(
                    admitted.record.organizationId,
                    admitted.record.expiresAt,
                    1,
                ),
            ).toEqual([]);
            const indexes = await source.query(
                "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname LIKE 'IDX_runtime_external_%'",
            );
            expect(
                indexes.map((i: { indexname: string }) => i.indexname),
            ).toEqual(
                expect.arrayContaining([
                    'IDX_runtime_external_pending',
                    'IDX_runtime_external_terminal',
                    'IDX_runtime_external_receipt_alias',
                ]),
            );
        });
        it('preserves recent aliases, then cascades only eligible old terminal receipts', async () => {
            const admitted = await input();
            await store().admit(admitted);
            await store().complete(
                admitted.record.organizationId,
                admitted.record.verificationTaskId,
                { state: 'failed', result: {}, updatedAt: admitted.at },
            );
            const day = 86400_000;
            const created = Date.parse(admitted.at);
            await store().admit({
                ...admitted,
                reuseOnly: true,
                request: undefined,
                messageId: 'fresh-alias',
                at: new Date(created + 29 * day).toISOString(),
            });
            expect(
                await store().purgeTerminal(
                    admitted.record.organizationId,
                    new Date(created + day).toISOString(),
                    25,
                ),
            ).toBe(0);
            expect(
                await store().purgeTerminal(
                    'org-foreign',
                    new Date(created + 31 * day).toISOString(),
                    25,
                ),
            ).toBe(0);
            expect(
                await store().purgeTerminal(
                    admitted.record.organizationId,
                    new Date(created + 31 * day).toISOString(),
                    25,
                ),
            ).toBe(1);
            expect(
                await store().byTask(
                    admitted.record.organizationId,
                    admitted.record.verificationTaskId,
                ),
            ).toBeNull();
            expect(
                (
                    await source.query(
                        'SELECT count(*)::int AS n FROM runtime_external_message_keys',
                    )
                )[0].n,
            ).toBe(0);
            await expect(
                store().admit({
                    ...admitted,
                    reuseOnly: true,
                    request: undefined,
                    messageId: 'stale',
                }),
            ).rejects.toMatchObject({ code: 'receipt_expired' });
        });
        it('protects old finding relatives while a retry is live or recent', async () => {
            const admitted = await input();
            await store().admit(admitted);
            await store().complete(
                admitted.record.organizationId,
                admitted.record.verificationTaskId,
                { state: 'failed', result: {}, updatedAt: admitted.at },
            );
            const retry = structuredClone(admitted);
            retry.record.receiptId = randomUUID();
            retry.record.verificationTaskId = randomUUID();
            retry.record.fingerprint = 'f'.repeat(64);
            retry.record.runId = randomUUID();
            retry.messageId = 'retry';
            retry.request!.runId = retry.record.runId;
            retry.request!.externalVerification!.taskId =
                retry.record.verificationTaskId;
            await store().admit(retry);
            const cutoff = new Date(
                Date.parse(admitted.at) + 86400_000,
            ).toISOString();
            expect(
                await store().purgeTerminal(
                    admitted.record.organizationId,
                    cutoff,
                    25,
                ),
            ).toBe(0);
            await store().complete(
                admitted.record.organizationId,
                retry.record.verificationTaskId,
                { state: 'completed', result: {}, updatedAt: cutoff },
            );
            expect(
                await store().purgeTerminal(
                    admitted.record.organizationId,
                    cutoff,
                    25,
                ),
            ).toBe(0);
            const older = new Date(
                Date.parse(cutoff) + 86400_000,
            ).toISOString();
            expect(
                await store().purgeTerminal(
                    admitted.record.organizationId,
                    older,
                    25,
                ),
            ).toBe(2);
        });
        it('serializes purge with alias admission without resurrecting a retired task', async () => {
            const admitted = await input();
            await store().admit(admitted);
            await store().complete(
                admitted.record.organizationId,
                admitted.record.verificationTaskId,
                { state: 'failed', result: {}, updatedAt: admitted.at },
            );
            const fresh = new Date(
                Date.parse(admitted.at) + 31 * 86400_000,
            ).toISOString();
            const results = await Promise.allSettled([
                store().purgeTerminal(
                    admitted.record.organizationId,
                    fresh,
                    25,
                ),
                store().admit({
                    ...admitted,
                    reuseOnly: true,
                    request: undefined,
                    messageId: 'racing-alias',
                    at: fresh,
                }),
            ]);
            const exists = await store().byTask(
                admitted.record.organizationId,
                admitted.record.verificationTaskId,
            );
            if (!exists)
                expect(results[1]).toMatchObject({
                    status: 'rejected',
                    reason: { code: 'receipt_expired' },
                });
            else
                expect(
                    await store().byMessage(
                        admitted.record.organizationId,
                        admitted.record.keyId,
                        'racing-alias',
                    ),
                ).not.toBeNull();
            expect(
                (
                    await source.query(
                        'SELECT count(*)::int AS n FROM fixture_external_outbox',
                    )
                )[0].n,
            ).toBe(1);
        });
        it('skips a busy admission org without waiting for its lock', async () => {
            const admitted = await input();
            await store().admit(admitted);
            await store().complete(
                admitted.record.organizationId,
                admitted.record.verificationTaskId,
                { state: 'failed', result: {}, updatedAt: admitted.at },
            );
            const lock = source.createQueryRunner();
            await lock.connect();
            await lock.startTransaction();
            try {
                await lock.query(
                    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                    [admitted.record.organizationId],
                );
                expect(
                    await store().purgeTerminal(
                        admitted.record.organizationId,
                        new Date(
                            Date.parse(admitted.at) + 86400_000,
                        ).toISOString(),
                        25,
                    ),
                ).toBe(0);
            } finally {
                await lock.rollbackTransaction();
                await lock.release();
            }
        });
    },
);
