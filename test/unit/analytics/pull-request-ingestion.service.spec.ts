import {
    PR_INGESTION_WATERMARK,
    PullRequestIngestionService,
} from '@libs/ee/analytics-warehouse/ingestion/pull-request-ingestion.service';

/**
 * Unit specs for the daily ingestion logic. Mocks both the analytics
 * DataSource and the Mongoose model — no DB roundtrip. Focused on the
 * decision-making (watermark/tuple/mode/filter) and the orchestration
 * (transaction → savepoints → quarantine), not on the SQL strings.
 *
 * Integration coverage (real Postgres, real SAVEPOINT) lives in the
 * Tier-2 test suite (`scripts/analytics/test-suite.sh`).
 */

interface MockQueryRecord {
    sql: string;
    params?: unknown[];
}

function makeManager() {
    const calls: MockQueryRecord[] = [];
    return {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return [];
        }),
        calls,
    };
}

function makeDataSource(opts?: {
    watermarkRow?: {
        last_source_updated_at: Date | null;
        last_source_id: string | null;
    } | null;
    onTransactionPrPath?: (
        manager: ReturnType<typeof makeManager>,
        prIndex: number,
    ) => void | Promise<void>;
}) {
    const calls: MockQueryRecord[] = [];
    const managers: ReturnType<typeof makeManager>[] = [];
    let prCounter = 0;

    const ds = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            // readWatermark returns the seeded row.
            if (sql.includes('FROM "analytics"."watermarks"')) {
                return opts?.watermarkRow !== undefined
                    ? opts.watermarkRow
                        ? [opts.watermarkRow]
                        : []
                    : [];
            }
            // startRun returns id=1.
            if (sql.includes('INSERT INTO "analytics"."ingestion_runs"')) {
                return [{ id: '1' }];
            }
            return [];
        }),
        transaction: jest.fn(async (cb: (manager: unknown) => unknown) => {
            const manager = makeManager();
            // Hook so a test can decide to throw on a specific PR's INSERT
            // by inspecting how many SAVEPOINTs were issued so far.
            const originalQuery = manager.query;
            manager.query = jest.fn(
                async (sql: string, params?: unknown[]) => {
                    if (
                        sql.startsWith('SAVEPOINT') &&
                        opts?.onTransactionPrPath
                    ) {
                        await opts.onTransactionPrPath(manager, prCounter);
                        prCounter += 1;
                    }
                    return (originalQuery as jest.Mock)(sql, params);
                },
            );
            managers.push(manager);
            return cb(manager);
        }),
    };
    return { ds, calls, managers };
}

function makeCursor(docs: unknown[]) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const d of docs) yield d;
        },
    };
}

function makeModel(docs: unknown[]) {
    const find = jest.fn();
    const read = jest.fn();
    const sort = jest.fn();
    const lean = jest.fn();
    const cursor = jest.fn();

    const chain: Record<string, jest.Mock> = {} as never;
    Object.assign(chain, {
        find,
        read,
        sort,
        lean,
        cursor,
    });

    find.mockReturnValue(chain);
    read.mockReturnValue(chain);
    sort.mockReturnValue(chain);
    lean.mockReturnValue(chain);
    cursor.mockReturnValue(makeCursor(docs));

    return chain as unknown as {
        find: jest.Mock;
        read: jest.Mock;
        sort: jest.Mock;
        lean: jest.Mock;
        cursor: jest.Mock;
    };
}

function makePR(input: {
    id: string;
    organizationId?: string;
    updatedAt?: Date;
    createdAt?: Date;
    files?: unknown[];
    commits?: unknown[];
}) {
    return {
        _id: input.id,
        organizationId: input.organizationId ?? 'org-1',
        repository: { id: 'repo-1', fullName: 'org/repo' },
        status: 'open',
        user: { id: 'u-1', username: 'dev' },
        totalChanges: 10,
        createdAt: (input.createdAt ?? new Date('2026-01-01')).toISOString(),
        openedAt: '2026-01-01',
        closedAt: null,
        updatedAt: input.updatedAt ?? new Date('2026-01-02'),
        files: input.files ?? [],
        commits: input.commits ?? [],
    };
}

function makeService(
    ds: ReturnType<typeof makeDataSource>['ds'],
    model: ReturnType<typeof makeModel>,
) {
    return new PullRequestIngestionService(
        ds as never,
        model as never,
    );
}

describe('PullRequestIngestionService.run()', () => {
    it('writes a heartbeat when nothing was scanned (incremental, empty Mongo)', async () => {
        const { ds, calls } = makeDataSource({ watermarkRow: null });
        const model = makeModel([]);
        const svc = makeService(ds, model);

        const res = await svc.run();

        expect(res.scanned).toBe(0);
        expect(res.upsertedPRs).toBe(0);
        expect(res.newWatermark).toBeNull();
        expect(res.newWatermarkId).toBeNull();

        const heartbeatHit = calls.some(
            (c) =>
                c.sql.includes('INSERT INTO "analytics"."watermarks"') &&
                c.sql.includes("'idle'"),
        );
        expect(heartbeatHit).toBe(true);

        const completeRunHit = calls.some(
            (c) =>
                c.sql.startsWith('UPDATE "analytics"."ingestion_runs"') &&
                Array.isArray(c.params) &&
                c.params[1] === 'ok',
        );
        expect(completeRunHit).toBe(true);
    });

    it('uses a tuple filter when a previous tuple watermark exists', async () => {
        const { ds } = makeDataSource({
            watermarkRow: {
                last_source_updated_at: new Date('2026-01-15T10:00:00Z'),
                last_source_id: '60a000000000000000000001',
            },
        });
        const model = makeModel([]);
        const svc = makeService(ds, model);

        await svc.run();

        const findCall = model.find.mock.calls[0];
        const filter = findCall[0];

        // Tuple filter: $gt on updatedAt OR same updatedAt with $gt _id.
        expect(filter.$or).toEqual([
            { updatedAt: { $gt: new Date('2026-01-15T10:00:00Z') } },
            {
                updatedAt: new Date('2026-01-15T10:00:00Z'),
                _id: expect.anything(),
            },
        ]);
        // Sort must include _id for stable resume order.
        expect(model.sort).toHaveBeenCalledWith({ updatedAt: 1, _id: 1 });
    });

    it('falls back to a scalar filter when the tuple id is missing (legacy row)', async () => {
        const { ds } = makeDataSource({
            watermarkRow: {
                last_source_updated_at: new Date('2026-01-15T10:00:00Z'),
                last_source_id: null,
            },
        });
        const model = makeModel([]);
        const svc = makeService(ds, model);

        await svc.run();

        const filter = model.find.mock.calls[0][0];
        expect(filter.$or).toBeUndefined();
        expect(filter.updatedAt).toEqual({
            $gt: new Date('2026-01-15T10:00:00Z'),
        });
    });

    it('advances the tuple watermark to the latest seen (updatedAt, _id)', async () => {
        const sharedTs = new Date('2026-02-01T12:00:00Z');
        const newerTs = new Date('2026-02-01T12:05:00Z');
        const { ds, calls } = makeDataSource({ watermarkRow: null });
        const model = makeModel([
            makePR({ id: 'aaa', updatedAt: sharedTs }),
            makePR({ id: 'bbb', updatedAt: sharedTs }),
            makePR({ id: 'ccc', updatedAt: newerTs }),
        ]);
        const svc = makeService(ds, model);

        const res = await svc.run();

        expect(res.scanned).toBe(3);
        expect(res.upsertedPRs).toBe(3);
        expect(res.newWatermark?.toISOString()).toBe(newerTs.toISOString());
        expect(res.newWatermarkId).toBe('ccc');

        const writeWmCall = calls.find(
            (c) =>
                c.sql.includes('INSERT INTO "analytics"."watermarks"') &&
                Array.isArray(c.params) &&
                c.params[0] === PR_INGESTION_WATERMARK &&
                c.params[1] instanceof Date,
        );
        expect(writeWmCall).toBeDefined();
        expect(writeWmCall?.params?.[1]).toEqual(newerTs);
        expect(writeWmCall?.params?.[2]).toBe('ccc');
    });

    it('advances ONLY the tiebreaker _id when timestamps tie at the boundary', async () => {
        const sharedTs = new Date('2026-02-01T12:00:00Z');
        const { ds, calls } = makeDataSource({ watermarkRow: null });
        // Cursor sorted ASC by (updatedAt, _id) so the LAST doc seen at
        // a tied timestamp wins the tiebreaker.
        const model = makeModel([
            makePR({ id: 'aaa', updatedAt: sharedTs }),
            makePR({ id: 'bbb', updatedAt: sharedTs }),
            makePR({ id: 'ccc', updatedAt: sharedTs }),
        ]);
        const svc = makeService(ds, model);

        const res = await svc.run();

        expect(res.newWatermark?.toISOString()).toBe(sharedTs.toISOString());
        expect(res.newWatermarkId).toBe('ccc');

        const writeWm = calls.find((c) =>
            c.sql.includes('INSERT INTO "analytics"."watermarks"'),
        );
        expect(writeWm?.params?.[2]).toBe('ccc');
    });

    it('does NOT touch the watermark when an explicit window is passed (replay/backfill)', async () => {
        const { ds, calls } = makeDataSource({ watermarkRow: null });
        const model = makeModel([
            makePR({ id: 'aaa', createdAt: new Date('2026-03-01') }),
        ]);
        const svc = makeService(ds, model);

        await svc.run({
            since: new Date('2026-03-01'),
            until: new Date('2026-03-08'),
            cursorField: 'createdAt',
        });

        // No watermark write of any kind.
        const wmTouches = calls.filter((c) =>
            c.sql.includes('"analytics"."watermarks"'),
        );
        expect(wmTouches).toHaveLength(0);

        // And the filter targets createdAt range, not updatedAt $gt.
        const filter = model.find.mock.calls[0][0];
        expect(filter.createdAt).toEqual({
            $gte: new Date('2026-03-01'),
            $lt: new Date('2026-03-08'),
        });
        expect(filter.updatedAt).toBeUndefined();
    });

    it('applies an organizationId scope when provided', async () => {
        const { ds } = makeDataSource({ watermarkRow: null });
        const model = makeModel([]);
        const svc = makeService(ds, model);

        await svc.run({ organizationId: 'org-42' });

        const filter = model.find.mock.calls[0][0];
        expect(filter.organizationId).toBe('org-42');
    });

    it('only requests the projection fields the warehouse actually needs', async () => {
        const { ds } = makeDataSource({ watermarkRow: null });
        const model = makeModel([]);
        const svc = makeService(ds, model);

        await svc.run();

        const projection = model.find.mock.calls[0][1];
        // Spot-check: pesky-and-unused fields like `prLevelSuggestions`
        // should NOT cross the wire.
        expect(projection).not.toHaveProperty('prLevelSuggestions');
        expect(projection).not.toHaveProperty('reviewers');
        // Required fields are present.
        for (const k of [
            '_id',
            'organizationId',
            'repository',
            'status',
            'user',
            'totalChanges',
            'createdAt',
            'openedAt',
            'closedAt',
            'updatedAt',
            'files',
            'commits',
        ]) {
            expect(projection).toHaveProperty(k);
        }
    });

    it('reads from a Mongo secondary so the OLTP write path is unaffected', async () => {
        const { ds } = makeDataSource({ watermarkRow: null });
        const model = makeModel([]);
        const svc = makeService(ds, model);

        await svc.run();

        expect(model.read).toHaveBeenCalledWith('secondaryPreferred');
    });

    it('skips suggestions without an id instead of quarantining the PR', async () => {
        // Mongo has a mix: one sent+id (real delivered), one not_sent
        // with no id (draft that never posted). The old behavior was a
        // NOT NULL violation → SAVEPOINT rollback → whole PR lost. The
        // fix is to skip id-less ones silently.
        const pr = makePR({
            id: 'pr-mixed',
            files: [
                {
                    path: 'src/foo.ts',
                    suggestions: [
                        { id: 'sug-sent', deliveryStatus: 'sent' },
                        { deliveryStatus: 'not_sent' }, // no `id`
                    ],
                },
            ],
        });
        const { ds, managers } = makeDataSource({ watermarkRow: null });
        const model = makeModel([pr]);
        const svc = makeService(ds, model);

        const res = await svc.run();

        // PR succeeds (no quarantine) and the sibling got written.
        expect(res.quarantined).toBe(0);
        expect(res.upsertedPRs).toBe(1);

        const inserts =
            managers[0]?.calls.filter((c) =>
                c.sql.includes(
                    'INSERT INTO "analytics"."suggestions_mv"',
                ),
            ) ?? [];
        expect(inserts).toHaveLength(1);
        expect(inserts[0].params?.[0]).toBe('sug-sent');
    });

    it('reads commit_timestamp from created_at or author.date when commit_timestamp is absent', async () => {
        // Real webhook payloads arrive with `created_at` (snake_case)
        // or `author.date`, not `commit_timestamp` — the writer has to
        // fall through, otherwise 99%+ of commits land with a NULL
        // timestamp and every lead-time query breaks.
        const pr = makePR({
            id: 'pr-commits',
            commits: [
                { sha: 'sha-a', created_at: '2026-03-10T12:00:00Z' },
                { sha: 'sha-b', author: { date: '2026-03-11T08:00:00Z', username: 'alice' } },
                { sha: 'sha-c', commit_timestamp: '2026-03-12T09:00:00Z' },
            ],
        });
        const { ds, managers } = makeDataSource({ watermarkRow: null });
        const model = makeModel([pr]);
        const svc = makeService(ds, model);

        await svc.run();

        const inserts =
            managers[0]?.calls.filter((c) =>
                c.sql.includes('INSERT INTO "analytics"."commits_view"'),
            ) ?? [];
        expect(inserts).toHaveLength(3);
        // Position 4 in the param list is the parsed `commit_timestamp`.
        const tsValues = inserts.map(
            (c) => (c.params as unknown[])[3] as Date,
        );
        expect(tsValues[0]).toBeInstanceOf(Date);
        expect(tsValues[0].toISOString()).toBe('2026-03-10T12:00:00.000Z');
        expect(tsValues[1].toISOString()).toBe('2026-03-11T08:00:00.000Z');
        expect(tsValues[2].toISOString()).toBe('2026-03-12T09:00:00.000Z');
    });
});
