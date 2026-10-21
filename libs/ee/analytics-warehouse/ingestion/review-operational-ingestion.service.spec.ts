import { ReviewOperationalIngestionService } from './review-operational-ingestion.service';

/**
 * Mutation-killing unit tests for the deterministic logic in
 * ReviewOperationalIngestionService: `fetchBatch` (parameter accumulation,
 * placeholder-index arithmetic, org filter and keyset-cursor SQL fragments)
 * and `writeBatch` (row fan-out, per-row placeholder offsets, pull-request
 * number coercion and the empty-input guard).
 *
 * The service has a heavy NestJS constructor (two TypeORM DataSources);
 * neither method under test touches anything the constructor requires beyond
 * `query`/`transaction`, so the instance is built with recording stubs and the
 * private methods are reached via `(instance as any)`.
 */
describe('ReviewOperationalIngestionService (deterministic logic)', () => {
    /** Builds a service with recording stub DataSources. */
    function makeService() {
        const appQuery = jest.fn().mockResolvedValue([]);
        const managerQuery = jest.fn().mockResolvedValue(undefined);
        const transaction = jest.fn(async (cb: any) =>
            cb({ query: managerQuery }),
        );
        const appDs = { query: appQuery } as any;
        const analyticsDs = { transaction } as any;
        const service = new ReviewOperationalIngestionService(
            analyticsDs,
            appDs,
        );
        return { service, appQuery, managerQuery, transaction };
    }

    const fetchBatch = (svc: any, watermark: any, org: any, size: number) =>
        (svc as any).fetchBatch(watermark, org, size);

    const writeBatch = (svc: any, rows: any[]) => (svc as any).writeBatch(rows);

    describe('fetchBatch — parameters and SQL fragments', () => {
        it('no org, no watermark: params is exactly [batchSize] and no filters are emitted', async () => {
            const { service, appQuery } = makeService();
            await fetchBatch(service, null, undefined, 500);

            expect(appQuery).toHaveBeenCalledTimes(1);
            const [sql, params] = appQuery.mock.calls[0];

            // Only the LIMIT parameter is bound.
            expect(params).toEqual([500]);

            // Neither optional predicate is present. The cursor predicate is
            // the only fragment that casts to ::timestamp (the static 6-month
            // floor uses `ae."updatedAt" >= now()`), so its absence is exact.
            expect(sql).not.toContain('t."organization_id" =');
            expect(sql).not.toContain('::timestamp');

            // Static predicate keeps the inlined terminal statuses verbatim.
            expect(sql).toContain(
                `ae."status" IN ('success', 'error', 'partial_error', 'skipped')`,
            );
            // The 6-month backfill window is inlined into both floors.
            expect(sql).toContain(`INTERVAL '6 months'`);
            // Keyset ordering and LIMIT binding.
            expect(sql).toContain('ORDER BY ae."updatedAt" ASC, ae."uuid" ASC');
            expect(sql).toContain('LIMIT $1');
        });

        it('org, no watermark: pushes org as $2 and emits the org filter at that index', async () => {
            const { service, appQuery } = makeService();
            await fetchBatch(service, null, 'org-1', 500);

            const [sql, params] = appQuery.mock.calls[0];
            expect(params).toEqual([500, 'org-1']);
            expect(sql).toContain('AND t."organization_id" = $2');
            // No cursor predicate.
            expect(sql).not.toContain('::timestamp');
        });

        it('watermark with updatedAt but no id, no org: single-sided cursor at $2', async () => {
            const { service, appQuery } = makeService();
            const wm = { updatedAt: '2026-01-01 00:00:00.000000', id: null };
            await fetchBatch(service, wm, undefined, 500);

            const [sql, params] = appQuery.mock.calls[0];
            expect(params).toEqual([500, '2026-01-01 00:00:00.000000']);
            expect(sql).toContain('AND ae."updatedAt" > $2::timestamp');
            // No id => no uuid tie-break branch.
            expect(sql).not.toContain('ae."uuid" > ');
            expect(sql).not.toContain('ae."updatedAt" = $2::timestamp');
        });

        it('watermark with updatedAt AND id, with org: indices are $2/$3/$4 in push order', async () => {
            const { service, appQuery } = makeService();
            const wm = {
                updatedAt: '2026-01-01 00:00:00.000000',
                id: 'uuid-9',
            };
            await fetchBatch(service, wm, 'org-1', 500);

            const [sql, params] = appQuery.mock.calls[0];
            // Push order: batchSize, org, updatedAt, id.
            expect(params).toEqual([
                500,
                'org-1',
                '2026-01-01 00:00:00.000000',
                'uuid-9',
            ]);
            expect(sql).toContain('AND t."organization_id" = $2');
            // updatedAt bound at $3 (both comparisons), uuid tie-break at $4.
            expect(sql).toContain('ae."updatedAt" > $3::timestamp');
            expect(sql).toContain('ae."updatedAt" = $3::timestamp');
            expect(sql).toContain('ae."uuid" > $4::uuid');
        });

        it('empty-string updatedAt is falsy: no cursor predicate is emitted even with an id present', async () => {
            const { service, appQuery } = makeService();
            const wm = { updatedAt: '', id: 'uuid-9' };
            await fetchBatch(service, wm, undefined, 500);

            const [sql, params] = appQuery.mock.calls[0];
            expect(params).toEqual([500]);
            expect(sql).not.toContain('::timestamp');
            expect(sql).not.toContain('ae."uuid" > ');
        });

        it('returns exactly what appDs.query resolves to', async () => {
            const { service, appQuery } = makeService();
            const resultRows = [{ automation_execution_id: 'x' }];
            appQuery.mockResolvedValueOnce(resultRows);

            const out = await fetchBatch(service, null, undefined, 10);
            expect(out).toBe(resultRows);
        });

        it('binds the batchSize argument verbatim as $1', async () => {
            const { service, appQuery } = makeService();
            await fetchBatch(service, null, undefined, 7);
            const [, params] = appQuery.mock.calls[0];
            expect(params[0]).toBe(7);
        });
    });

    describe('writeBatch — insert fan-out and coercion', () => {
        function makeRow(overrides = {}) {
            return {
                automation_execution_id: 'ae-1',
                organization_id: 'org-1',
                team_id: 'team-1',
                team_automation_id: 'ta-1',
                repository_id: 'repo-1',
                repo_full_name: 'acme/repo',
                pull_request_number: 42,
                status: 'success',
                created_at: new Date('2026-01-01T00:00:00Z'),
                source_updated_at: '2026-01-02 00:00:00.000000',
                ...overrides,
            };
        }

        it('returns 0 and performs no transaction for an empty batch', async () => {
            const { service, transaction, managerQuery } = makeService();
            const result = await writeBatch(service, []);
            expect(result).toBe(0);
            expect(transaction).not.toHaveBeenCalled();
            expect(managerQuery).not.toHaveBeenCalled();
        });

        it('maps every column in order for a single row and returns the row count', async () => {
            const { service, managerQuery, transaction } = makeService();
            const row = makeRow();
            const result = await writeBatch(service, [row]);

            expect(result).toBe(1);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(managerQuery).toHaveBeenCalledTimes(1);

            const [sql, params] = managerQuery.mock.calls[0];
            expect(params).toEqual([
                'ae-1',
                'org-1',
                'team-1',
                'ta-1',
                'repo-1',
                'acme/repo',
                42,
                'success',
                row.created_at,
                '2026-01-02 00:00:00.000000',
            ]);
            // Single-row placeholder tuple, 10 columns.
            expect(sql).toContain('($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)');
            expect(sql).toContain(
                'ON CONFLICT ("automation_execution_id") DO UPDATE SET',
            );
        });

        it('coerces a string pull_request_number to a number', async () => {
            const { service, managerQuery } = makeService();
            await writeBatch(service, [makeRow({ pull_request_number: '42' })]);
            const [, params] = managerQuery.mock.calls[0];
            expect(params[6]).toBe(42);
        });

        it('preserves pull_request_number 0 as the number 0 (guard is != null, not truthiness)', async () => {
            const { service, managerQuery } = makeService();
            await writeBatch(service, [makeRow({ pull_request_number: 0 })]);
            const [, params] = managerQuery.mock.calls[0];
            expect(params[6]).toBe(0);
        });

        it('maps null pull_request_number to null', async () => {
            const { service, managerQuery } = makeService();
            await writeBatch(service, [makeRow({ pull_request_number: null })]);
            const [, params] = managerQuery.mock.calls[0];
            expect(params[6]).toBeNull();
        });

        it('maps undefined pull_request_number to null', async () => {
            const { service, managerQuery } = makeService();
            await writeBatch(service, [
                makeRow({ pull_request_number: undefined }),
            ]);
            const [, params] = managerQuery.mock.calls[0];
            expect(params[6]).toBeNull();
        });

        it('offsets the second row placeholders by 10 and flattens all params in order', async () => {
            const { service, managerQuery } = makeService();
            const rowA = makeRow();
            const rowB = makeRow({
                automation_execution_id: 'ae-2',
                pull_request_number: 7,
                status: 'error',
            });
            const result = await writeBatch(service, [rowA, rowB]);

            expect(result).toBe(2);
            const [sql, params] = managerQuery.mock.calls[0];

            // Two placeholder tuples, second starting at $11.
            expect(sql).toContain('($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)');
            expect(sql).toContain(
                '($11, $12, $13, $14, $15, $16, $17, $18, $19, $20)',
            );

            expect(params).toHaveLength(20);
            // First row occupies 0..9, second 10..19.
            expect(params[0]).toBe('ae-1');
            expect(params[10]).toBe('ae-2');
            expect(params[16]).toBe(7);
            expect(params[17]).toBe('error');
        });
    });
});
