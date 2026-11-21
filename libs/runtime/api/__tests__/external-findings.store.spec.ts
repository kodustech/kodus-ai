import type { DataSource, EntityManager } from 'typeorm';
import { TypeOrmExternalFindingsStore } from '../infrastructure/typeorm-external-findings.store';
import { ExternalAdmissionError } from '../domain/external-findings';
import { externalFindingsFixture } from './fixtures/external-findings.fixture';

async function admission() {
    const h = externalFindingsFixture();
    await h.service.submit(h.principal, h.input, 'message');
    return {
        record: h.store.records[0],
        request: h.store.requests[0],
        bodyHash: 'a'.repeat(64),
        messageId: 'message',
        at: h.now().toISOString(),
    };
}
function database(rows: Array<unknown[]> = []) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const manager = {
        query: async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return rows.shift() ?? [];
        },
    } as unknown as EntityManager;
    const source = {
        query: manager.query,
        transaction: async (fn: (m: EntityManager) => Promise<unknown>) =>
            fn(manager),
    } as unknown as DataSource;
    const messages: Array<{ message: unknown; manager: unknown }> = [];
    const outbox = {
        create: async (message: unknown, m: unknown) => {
            messages.push({ message, manager: m });
        },
    };
    return {
        source,
        manager,
        calls,
        messages,
        outbox,
        store: new TypeOrmExternalFindingsStore(source, outbox),
    };
}
describe('product external finding transaction', () => {
    it('commits receipt/task, message alias and sealed Run through the same transaction manager', async () => {
        const input = await admission();
        const d = database([
            [],
            [],
            [{ message_count: '0' }],
            [],
            [{ key_count: '0', pr_count: '0' }],
            [],
            [],
        ]);
        expect(await d.store.admit(input)).toMatchObject({
            record: input.record,
            deduplicated: false,
        });
        expect(d.messages).toHaveLength(1);
        expect(d.messages[0].manager).toBe(d.manager);
        expect(d.calls[0].sql).toContain('pg_advisory_xact_lock');
        expect(
            d.calls.some((c) =>
                c.sql.includes('INSERT INTO runtime_external_submissions'),
            ),
        ).toBe(true);
        expect(
            d.calls.some((c) =>
                c.sql.includes('INSERT INTO runtime_external_message_keys'),
            ),
        ).toBe(true);
    });
    it('does not enqueue repeated admission and refuses a reused id with changed content', async () => {
        const input = await admission();
        const d = database([
            [],
            [{ record: input.record, body_hash: input.bodyHash }],
        ]);
        expect((await d.store.admit(input)).deduplicated).toBe(true);
        expect(d.messages).toHaveLength(0);
        const conflict = database([
            [],
            [{ record: input.record, body_hash: 'b'.repeat(64) }],
        ]);
        await expect(conflict.store.admit(input)).rejects.toMatchObject({
            code: 'idempotency_conflict',
        });
        expect(conflict.messages).toHaveLength(0);
    });
    it('deduplicates a second message alias without quota or another Run', async () => {
        const input = await admission();
        const d = database([
            [],
            [],
            [{ message_count: '0' }],
            [{ record: input.record }],
            [],
        ]);
        expect(
            (await d.store.admit({ ...input, request: undefined }))
                .deduplicated,
        ).toBe(true);
        expect(d.messages).toHaveLength(0);
        expect(
            d.calls.filter((c) =>
                c.sql.includes('INSERT INTO runtime_external_message_keys'),
            ),
        ).toHaveLength(1);
    });
    it.each([
        { key_count: '1000', pr_count: '0' },
        { key_count: '0', pr_count: '1000' },
    ])(
        'refuses atomic daily quota before writing or publishing %j',
        async (count) => {
            const input = await admission();
            const d = database([[], [], [{ message_count: '0' }], [], [count]]);
            await expect(d.store.admit(input)).rejects.toBeInstanceOf(
                ExternalAdmissionError,
            );
            expect(d.messages).toHaveLength(0);
            expect(d.calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
        },
    );
    it('refuses a sealed request bound to another head or task', async () => {
        const input = await admission();
        const d = database();
        await expect(
            d.store.admit({
                ...input,
                request: {
                    ...input.request!,
                    pullRequest: {
                        ...input.request!.pullRequest,
                        headSha: 'c'.repeat(40),
                    },
                },
            }),
        ).rejects.toThrow();
        expect(d.messages).toHaveLength(0);
        expect(d.calls).toHaveLength(0);
    });
    it('scopes every task/finding/message query by organization', async () => {
        const d = database();
        await d.store.byTask('org-a', '00000000-0000-4000-8000-000000000001');
        await d.store.byFinding(
            'org-a',
            '00000000-0000-4000-8000-000000000002',
        );
        await d.store.byMessage('org-a', 'key', 'message');
        await d.store.byFingerprint('org-a', 'key', 'hash');
        expect(d.calls).toHaveLength(4);
        for (const call of d.calls) {
            expect(call.sql).toContain('organization_id');
            expect(call.params?.[0]).toBe('org-a');
        }
    });
    it('bounds new duplicate aliases while keeping exact message retries free', async () => {
        const input = await admission();
        const d = database([[], [], [{ message_count: '4000' }]]);
        await expect(d.store.admit(input)).rejects.toMatchObject({
            code: 'message_quota_exceeded',
        });
        expect(d.messages).toHaveLength(0);
        expect(d.calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
    });
    it('accepts the exact same admitted probe after PostgreSQL jsonb reordered its object keys', async () => {
        const input = await admission();
        const reverse = (v: unknown): unknown =>
            Array.isArray(v)
                ? v.map(reverse)
                : v && typeof v === 'object'
                  ? Object.fromEntries(
                        Object.entries(v)
                            .reverse()
                            .map(([k, x]) => [k, reverse(x)]),
                    )
                  : v;
        input.record.submission = reverse(
            input.record.submission,
        ) as typeof input.record.submission;
        const d = database([
            [],
            [],
            [{ message_count: '0' }],
            [],
            [{ key_count: '0', pr_count: '0' }],
            [],
            [],
        ]);
        await expect(d.store.admit(input)).resolves.toMatchObject({
            deduplicated: false,
        });
    });
});

describe('external lifecycle maintenance store', () => {
    it('does not recreate a stale alias-only receipt after retention', async () => {
        const input = await admission();
        input.record.refusal = 'runtime_stopped';
        delete input.record.runId;
        const d = database([[], [], [{ message_count: '0' }], []]);
        await expect(
            d.store.admit({ ...input, request: undefined, reuseOnly: true }),
        ).rejects.toMatchObject({ code: 'receipt_expired' });
        expect(d.calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
    });
    it('bounds expiry lookup and always filters the requested organization', async () => {
        const d = database();
        await d.store.listExpiredTaskIds(
            'org-a',
            '2026-11-08T00:00:00.000Z',
            25,
        );
        expect(
            d.calls.some(
                (c) =>
                    c.sql.includes('organization_id=$1') &&
                    c.sql.includes('expires_at') &&
                    c.sql.includes('LIMIT'),
            ),
        ).toBe(true);
        await expect(
            d.store.listExpiredTaskIds(
                'org-a',
                '2026-11-08T00:00:00.000Z',
                101,
            ),
        ).rejects.toThrow();
    });
    it('reports an explicit SQL delete count rather than the driver result tuple length', async () => {
        const d = database([[], [{ acquired: true }], [{ removed: 0 }]]);
        expect(
            await d.store.purgeTerminal(
                'org-a',
                '2026-10-01T00:00:00.000Z',
                25,
            ),
        ).toBe(0);
    });
    it('takes the org admission lock and protects aliases and finding families during purge', async () => {
        const d = database([[], [{ acquired: true }], []]);
        await d.store.purgeTerminal('org-a', '2026-10-01T00:00:00.000Z', 25);
        expect(
            d.calls.some(
                (c) =>
                    c.sql.includes('pg_try_advisory_xact_lock') &&
                    c.params?.[0] === 'org-a',
            ),
        ).toBe(true);
        const deletion = d.calls.find((c) =>
            c.sql.includes('DELETE FROM runtime_external_submissions'),
        )!;
        expect(deletion.params?.[0]).toBe('org-a');
        expect(deletion.sql).toContain('runtime_external_message_keys');
        expect(deletion.sql).toContain('finding_ids &&');
        expect(deletion.sql).toContain('LIMIT');
    });
});
