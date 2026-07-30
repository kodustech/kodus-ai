import {
    REVIEW_OPERATIONAL_INGESTION_WATERMARK,
    ReviewOperationalIngestionService,
} from '@libs/ee/analytics-warehouse/ingestion/review-operational-ingestion.service';

interface QueryCall {
    sql: string;
    params?: unknown[];
}

function makeManager() {
    const calls: QueryCall[] = [];
    return {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return [];
        }),
        calls,
    };
}

function makeAnalyticsDs(opts?: {
    watermarkRow?: {
        last_source_updated_at: string | null;
        last_source_id: string | null;
    } | null;
}) {
    const calls: QueryCall[] = [];
    const managers: ReturnType<typeof makeManager>[] = [];
    const ds = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            if (sql.includes('FROM "analytics"."watermarks"')) {
                return opts?.watermarkRow ? [opts.watermarkRow] : [];
            }
            if (sql.includes('INSERT INTO "analytics"."ingestion_runs"')) {
                return [{ id: '1' }];
            }
            return [];
        }),
        transaction: jest.fn(async (cb: (manager: unknown) => unknown) => {
            const manager = makeManager();
            managers.push(manager);
            return cb(manager);
        }),
    };
    return { ds, calls, managers };
}

function makeAppDs(batches: unknown[][]) {
    const calls: QueryCall[] = [];
    const ds = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return batches.shift() ?? [];
        }),
    };
    return { ds, calls };
}

describe('ReviewOperationalIngestionService.run()', () => {
    it('imports terminal review executions into analytics and advances the watermark', async () => {
        const sourceUpdatedAt = '2026-06-10 10:00:00.123456';
        const { ds: analyticsDs, calls: analyticsCalls, managers } =
            makeAnalyticsDs();
        const { ds: appDs, calls: appCalls } = makeAppDs([
            [
                {
                    automation_execution_id:
                        '11111111-1111-1111-1111-111111111111',
                    organization_id: 'org-1',
                    team_id: '22222222-2222-2222-2222-222222222222',
                    team_automation_id:
                        '33333333-3333-3333-3333-333333333333',
                    repository_id: 'repo-1',
                    repo_full_name: 'org/repo',
                    pull_request_number: 123,
                    status: 'success',
                    created_at: new Date('2026-06-10T09:00:00Z'),
                    source_updated_at: sourceUpdatedAt,
                },
            ],
        ]);
        const service = new ReviewOperationalIngestionService(
            analyticsDs as never,
            appDs as never,
        );

        const result = await service.run({ batchSize: 10 });

        expect(result).toMatchObject({
            scanned: 1,
            upserted: 1,
            newWatermark: sourceUpdatedAt,
        });

        expect(appCalls[0].sql).toContain('FROM "automation_execution" ae');
        expect(appCalls[0].sql).toContain('"code_review_execution" cre');
        // statuses inlined as enum literals (matches the partial index predicate)
        expect(appCalls[0].sql).toContain(
            `ae."status" IN ('success', 'error', 'partial_error', 'skipped')`,
        );
        expect(appCalls[0].sql).not.toContain('::text = ANY');
        // native uuid ordering (no ::text cast) so the index satisfies ORDER BY
        expect(appCalls[0].sql).toContain('ORDER BY ae."updatedAt" ASC, ae."uuid" ASC');
        // 6-month backfill floor on both createdAt and updatedAt.
        expect(appCalls[0].sql).toContain(
            `ae."createdAt" >= now() - INTERVAL '6 months'`,
        );
        expect(appCalls[0].sql).toContain(
            `ae."updatedAt" >= now() - INTERVAL '6 months'`,
        );

        const writeCall = managers[0].calls[0];
        expect(writeCall.sql).toContain(
            'INSERT INTO "analytics"."review_operational_executions"',
        );
        expect(writeCall.params?.[1]).toBe('org-1');
        expect(writeCall.params?.[5]).toBe('org/repo');

        const watermarkCall = analyticsCalls.find((call) =>
            call.sql.includes('INSERT INTO "analytics"."watermarks"'),
        );
        expect(watermarkCall?.params).toEqual([
            REVIEW_OPERATIONAL_INGESTION_WATERMARK,
            sourceUpdatedAt,
            '11111111-1111-1111-1111-111111111111',
        ]);
    });

    it('resumes from tuple watermark when one already exists', async () => {
        const watermarkAt = '2026-06-10 10:00:00.123456';
        const { ds: analyticsDs } = makeAnalyticsDs({
            watermarkRow: {
                last_source_updated_at: watermarkAt,
                last_source_id: '11111111-1111-1111-1111-111111111111',
            },
        });
        const { ds: appDs, calls: appCalls } = makeAppDs([[]]);
        const service = new ReviewOperationalIngestionService(
            analyticsDs as never,
            appDs as never,
        );

        await service.run();

        expect(appCalls[0].sql).toContain('ae."updatedAt" > $2::timestamp');
        expect(appCalls[0].sql).toContain('ae."uuid" > $3::uuid');
        expect(appCalls[0].params).toEqual([
            500,
            watermarkAt,
            '11111111-1111-1111-1111-111111111111',
        ]);
    });

    it('keeps the greatest tuple when advancing the watermark at the same timestamp', async () => {
        const { ds: analyticsDs, calls } = makeAnalyticsDs();
        const { ds: appDs } = makeAppDs([]);
        const service = new ReviewOperationalIngestionService(
            analyticsDs as never,
            appDs as never,
        );

        await (
            service as unknown as {
                writeWatermark: (
                    at: Date,
                    id: string | null,
                ) => Promise<void>;
            }
        ).writeWatermark(
            new Date('2026-06-10T10:00:00Z'),
            '22222222-2222-2222-2222-222222222222',
        );

        const watermarkCall = calls.find((call) =>
            call.sql.includes('INSERT INTO "analytics"."watermarks"'),
        );
        expect(watermarkCall?.sql).toContain(
            'EXCLUDED."last_source_updated_at" = "analytics"."watermarks"."last_source_updated_at"',
        );
        expect(watermarkCall?.sql).toContain(
            'COALESCE(EXCLUDED."last_source_id", \'\') > COALESCE',
        );
    });
});
