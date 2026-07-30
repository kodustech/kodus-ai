/**
 * REAL integration test for the cockpit "Kodus Review" analytics stack.
 *
 * What runs for real here:
 *  - a throwaway Postgres 16 (docker) — no SQL is mocked;
 *  - the actual TypeORM migrations (init + phase 2 + phase 3), including
 *    the `brokenKodyRulesIds` JSONB backfill;
 *  - the actual ingestion services (`PullRequestIngestionService`,
 *    `FeedbackIngestionService`) writing through their real SQL — only the
 *    Mongo cursor is faked (fixture docs streamed through the same
 *    `.find().read().sort().lean().cursor()` chain);
 *  - the actual `CockpitReviewAnalyticsService` queries.
 *
 * Every assertion is a hand-computed number from the seeded scenario —
 * if a query regression changes any metric, this fails with the exact
 * mismatching value.
 *
 * Requires docker. Skips itself when the daemon is unavailable (CI
 * runners without docker, etc.).
 */
import { execSync } from 'child_process';

import { DataSource } from 'typeorm';

import { CockpitReviewAnalyticsService } from '@libs/cockpit/infrastructure/services/cockpit-review-analytics.service';
import { GetKodyRulesHealthUseCase } from '@libs/cockpit/application/use-cases/get-kody-rules-health.use-case';
import { FeedbackIngestionService } from '@libs/ee/analytics-warehouse/ingestion/feedback-ingestion.service';
import { PullRequestIngestionService } from '@libs/ee/analytics-warehouse/ingestion/pull-request-ingestion.service';
import { InitAnalyticsSchema2026042000000 } from '@libs/ee/analytics-warehouse/migrations/2026042000000-InitAnalyticsSchema';
import { AddRuleIdsAndPrNumber2026060612000000 } from '@libs/ee/analytics-warehouse/migrations/2026060612000000-AddRuleIdsAndPrNumber';
import { AddSuggestionFeedback2026060613000000 } from '@libs/ee/analytics-warehouse/migrations/2026060613000000-AddSuggestionFeedback';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.setTimeout(240_000);

const CONTAINER = 'pg-review-analytics-itest';
const PORT = 55446;

function dockerAvailable(): boolean {
    try {
        execSync('docker info', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Streams fixture docs through the mongoose-cursor-shaped chain. */
function fakeMongooseModel(docs: unknown[]) {
    return {
        find: jest.fn(() => ({
            read: () => ({
                sort: () => ({
                    lean: () => ({
                        cursor: () =>
                            (async function* () {
                                for (const d of docs) yield d;
                            })(),
                    }),
                }),
            }),
        })),
    };
}

const d = (s: string) => new Date(s);

// ---------------------------------------------------------------------
// Fixture scenario (org-1, window 2026-03-01 → 2026-06-01)
//
//   PR    repo     closed       #    suggestions (sent unless noted)
//   pr-1  org/api  2026-05-20  101   s1 critical/security  IMPL   [rule-sec]
//                                    s2 critical/security  not    [rule-sec]
//                                    s3 low/code_style     not
//                                    s4 medium/performance PARTIAL
//   pr-2  org/api  2026-05-27  102   s5 high/error_handling IMPL
//                                    s6 low/code_style      not   [rule-style]
//                                    s7 medium/code_style   (NOT SENT — excluded)
//                                    s13,s14,s15 low/code_style not
//   pr-3  org/web  2026-04-10  103   s8 critical/security   not
//                                    s9 low/refactoring     IMPL
//   pr-4  org/api  OPEN        104   s10 critical/security  not  (explorer only)
//   pr-5  org-2    in window          s11 IMPL                  (other org)
//   pr-6  org/api  2026-01-15        s12 IMPL                  (out of window)
//
// Closed-PR totals (org-1): sent 11, implemented 4 (s1, s4, s5, s9).
//
// Feedback (created):           up  down
//   s3  2026-05-21 org/api       0     3
//   s6  2026-05-28 org/api       0     2
//   s5  2026-05-28 org/api       2     0
//   s9  2026-04-11 org/web       1     0
//   org-2 doc                    0     5   (must not leak)
// ---------------------------------------------------------------------

const sugg = (
    id: string,
    label: string,
    severity: string,
    implementationStatus: string | null,
    createdAt: string,
    extra: Record<string, unknown> = {},
) => ({
    id,
    label,
    severity,
    deliveryStatus: 'sent',
    implementationStatus,
    createdAt,
    oneSentenceSummary: `summary of ${id}`,
    comment: { id: Number(id.replace(/\D/g, '')) + 9000 },
    ...extra,
});

const prDoc = (
    id: string,
    org: string,
    repoFullName: string,
    number: number,
    status: string,
    closedAt: string | null,
    suggestions: unknown[],
) => ({
    _id: id,
    organizationId: org,
    number,
    repository: { id: `repo-${repoFullName}`, fullName: repoFullName },
    status,
    user: { id: 'u1', username: 'dev' },
    totalChanges: 10,
    createdAt: '2026-03-02T00:00:00.000Z',
    openedAt: '2026-03-02T00:00:00.000Z',
    closedAt,
    updatedAt: d(closedAt ?? '2026-05-25T00:00:00.000Z'),
    files: [{ path: `src/${id}.ts`, suggestions }],
    commits: [],
});

const PR_DOCS = [
    prDoc('pr-1', 'org-1', 'org/api', 101, 'closed', '2026-05-20T10:00:00.000Z', [
        sugg('s1', 'security', 'critical', 'implemented', '2026-05-19T10:00:00.000Z', {
            brokenKodyRulesIds: ['rule-sec'],
        }),
        sugg('s2', 'security', 'critical', 'not_implemented', '2026-05-19T10:00:00.000Z', {
            brokenKodyRulesIds: ['rule-sec'],
        }),
        sugg('s3', 'code_style', 'low', 'not_implemented', '2026-05-19T10:00:00.000Z'),
        sugg('s4', 'performance', 'medium', 'partially_implemented', '2026-05-19T10:00:00.000Z'),
    ]),
    prDoc('pr-2', 'org-1', 'org/api', 102, 'closed', '2026-05-27T10:00:00.000Z', [
        sugg('s5', 'error_handling', 'high', 'implemented', '2026-05-26T10:00:00.000Z'),
        sugg('s6', 'code_style', 'low', 'not_implemented', '2026-05-26T10:00:00.000Z', {
            brokenKodyRulesIds: ['rule-style'],
        }),
        {
            ...sugg('s7', 'code_style', 'medium', null, '2026-05-26T10:00:00.000Z'),
            deliveryStatus: 'not_sent',
        },
        sugg('s13', 'code_style', 'low', 'not_implemented', '2026-05-26T10:00:00.000Z'),
        sugg('s14', 'code_style', 'low', 'not_implemented', '2026-05-26T10:00:00.000Z'),
        sugg('s15', 'code_style', 'low', 'not_implemented', '2026-05-26T10:00:00.000Z'),
    ]),
    prDoc('pr-3', 'org-1', 'org/web', 103, 'closed', '2026-04-10T10:00:00.000Z', [
        sugg('s8', 'security', 'critical', 'not_implemented', '2026-04-09T10:00:00.000Z'),
        sugg('s9', 'refactoring', 'low', 'implemented', '2026-04-09T10:00:00.000Z'),
    ]),
    prDoc('pr-4', 'org-1', 'org/api', 104, 'open', null, [
        sugg('s10', 'security', 'critical', 'not_implemented', '2026-05-25T10:00:00.000Z'),
    ]),
    prDoc('pr-5', 'org-2', 'other/repo', 7, 'closed', '2026-05-15T10:00:00.000Z', [
        sugg('s11', 'security', 'critical', 'implemented', '2026-05-14T10:00:00.000Z'),
    ]),
    prDoc('pr-6', 'org-1', 'org/api', 99, 'closed', '2026-01-15T10:00:00.000Z', [
        sugg('s12', 'security', 'high', 'implemented', '2026-01-14T10:00:00.000Z'),
    ]),
];

const feedbackDoc = (
    suggestionId: string,
    org: string,
    repo: string,
    thumbsUp: number,
    thumbsDown: number,
    createdAt: string,
) => ({
    _id: `fb-${suggestionId}`,
    organizationId: org,
    suggestionId,
    reactions: { thumbsUp, thumbsDown },
    comment: { id: 1 },
    pullRequest: { id: 'pr-x', number: 1, repository: { id: 'r', fullName: repo } },
    createdAt: d(createdAt),
    updatedAt: d(createdAt),
});

const FEEDBACK_DOCS = [
    feedbackDoc('s3', 'org-1', 'org/api', 0, 3, '2026-05-21T12:00:00.000Z'),
    feedbackDoc('s6', 'org-1', 'org/api', 0, 2, '2026-05-28T12:00:00.000Z'),
    feedbackDoc('s5', 'org-1', 'org/api', 2, 0, '2026-05-28T12:00:00.000Z'),
    feedbackDoc('s9', 'org-1', 'org/web', 1, 0, '2026-04-11T12:00:00.000Z'),
    feedbackDoc('s11', 'org-2', 'other/repo', 0, 5, '2026-05-16T12:00:00.000Z'),
];

const Q = {
    organizationId: 'org-1',
    startDate: '2026-03-01',
    endDate: '2026-06-01',
};

(dockerAvailable() ? describe : describe.skip)(
    'review analytics — real Postgres end-to-end',
    () => {
        let ds: DataSource;
        let service: CockpitReviewAnalyticsService;

        beforeAll(async () => {
            execSync(`docker rm -f ${CONTAINER} 2>/dev/null || true`, {
                shell: '/bin/bash',
                stdio: 'ignore',
            });
            execSync(
                `docker run -d --rm --name ${CONTAINER} -e POSTGRES_PASSWORD=test -p ${PORT}:5432 postgres:16-alpine`,
                { stdio: 'ignore' },
            );
            // The official postgres entrypoint runs initdb and then
            // RESTARTS the server — `pg_isready` passes during the init
            // phase and the first host TCP connection gets ECONNRESET.
            // Wait for the SECOND "ready to accept connections" in the
            // logs (post-restart) before connecting.
            for (let i = 0; i < 120; i++) {
                try {
                    const logs = execSync(`docker logs ${CONTAINER} 2>&1`, {
                        encoding: 'utf8',
                    });
                    const ready = (
                        logs.match(/ready to accept connections/g) ?? []
                    ).length;
                    if (ready >= 2) break;
                } catch {
                    // container still starting
                }
                await new Promise((r) => setTimeout(r, 500));
            }

            ds = new DataSource({
                type: 'postgres',
                host: '127.0.0.1',
                port: PORT,
                username: 'postgres',
                password: 'test',
                database: 'postgres',
            });
            // belt and braces: retry the first connection a few times
            for (let i = 0; ; i++) {
                try {
                    await ds.initialize();
                    await ds.query('SELECT 1');
                    break;
                } catch (err) {
                    if (i >= 10) throw err;
                    if (ds.isInitialized) await ds.destroy();
                    await new Promise((r) => setTimeout(r, 1000));
                }
            }

            // ---- run the REAL migrations ----
            const qr = ds.createQueryRunner();
            await new InitAnalyticsSchema2026042000000().up(qr);
            await new AddRuleIdsAndPrNumber2026060612000000().up(qr);
            await new AddSuggestionFeedback2026060613000000().up(qr);
            await qr.release();

            // ---- ingest fixtures through the REAL ingestion services ----
            const prIngestion = new PullRequestIngestionService(
                ds,
                fakeMongooseModel(PR_DOCS) as never,
            );
            const prRes = await prIngestion.run();
            expect(prRes.upsertedPRs).toBe(6);
            // 15 = every suggestion with an id, including s7 (not_sent —
            // it lands in the table; the queries filter it out).
            expect(prRes.insertedSuggestions).toBe(15);

            const fbIngestion = new FeedbackIngestionService(
                ds,
                fakeMongooseModel(FEEDBACK_DOCS) as never,
            );
            const fbRes = await fbIngestion.run();
            expect(fbRes.upserted).toBe(5);

            service = new CockpitReviewAnalyticsService(ds);
        });

        afterAll(async () => {
            await ds?.destroy();
            execSync(`docker rm -f ${CONTAINER} 2>/dev/null || true`, {
                shell: '/bin/bash',
                stdio: 'ignore',
            });
        });

        it('ingestion populated pr_number and brokenKodyRulesIds', async () => {
            const prs = await ds.query(
                `SELECT "_id", "pr_number" FROM analytics.pull_requests_opt ORDER BY "_id"`,
            );
            expect(prs.find((p: any) => p._id === 'pr-1').pr_number).toBe(101);

            const s1 = await ds.query(
                `SELECT "brokenKodyRulesIds" FROM analytics.suggestions_mv WHERE suggestion_id = 's1'`,
            );
            expect(s1[0].brokenKodyRulesIds).toEqual(['rule-sec']);
        });

        it('feedback ingestion advanced the watermark and is idempotent', async () => {
            const wm = await ds.query(
                `SELECT "last_source_updated_at" FROM analytics.watermarks WHERE table_name = 'code_review_feedback'`,
            );
            expect(new Date(wm[0].last_source_updated_at).toISOString()).toBe(
                '2026-05-28T12:00:00.000Z',
            );

            // re-running the same docs (backfill mode) overwrites, not duplicates
            const again = new FeedbackIngestionService(
                ds,
                fakeMongooseModel(FEEDBACK_DOCS) as never,
            );
            await again.run({ backfill: true });
            const count = await ds.query(
                `SELECT COUNT(*)::int AS c FROM analytics.suggestion_feedback`,
            );
            expect(count[0].c).toBe(5);
        });

        it('weekly implementation rate: exact weeks, totals and severity breakdown', async () => {
            const rows = await service.getImplementationRateWeekly(Q);

            expect(rows.map((r) => r.weekStart)).toEqual([
                '2026-04-06',
                '2026-05-18',
                '2026-05-25',
            ]);

            // week of pr-3: s8 (not), s9 (impl) → 2 sent, 1 impl
            expect(rows[0]).toMatchObject({ sent: 2, implemented: 1, rate: 0.5 });

            // week of pr-1: s1..s4 → 4 sent, 2 impl (s1 + s4 partial)
            expect(rows[1]).toMatchObject({ sent: 4, implemented: 2, rate: 0.5 });
            expect(rows[1].bySeverity).toEqual({
                critical: { sent: 2, implemented: 1, rate: 0.5 },
                low: { sent: 1, implemented: 0, rate: 0 },
                medium: { sent: 1, implemented: 1, rate: 1 },
            });

            // week of pr-2: s5,s6,s13,s14,s15 → 5 sent, 1 impl (s7 excluded!)
            expect(rows[2]).toMatchObject({ sent: 5, implemented: 1, rate: 0.2 });
        });

        it('implementation rate by category: exact counts', async () => {
            const rows = await service.getImplementationRateByCategory(Q);
            const byCat = Object.fromEntries(rows.map((r) => [r.category, r]));

            expect(byCat.code_style).toMatchObject({ sent: 5, implemented: 0, rate: 0 });
            expect(byCat.security).toMatchObject({ sent: 3, implemented: 1, rate: 0.33 });
            expect(byCat.performance).toMatchObject({ sent: 1, implemented: 1, rate: 1 });
            expect(byCat.error_handling).toMatchObject({ sent: 1, implemented: 1 });
            expect(byCat.refactoring).toMatchObject({ sent: 1, implemented: 1 });
            // not_sent suggestion (s7) and other-org/out-of-window rows excluded
            expect(rows.reduce((a, r) => a + r.sent, 0)).toBe(11);
        });

        it('implementation rate by severity: critical-first order, exact rates', async () => {
            const rows = await service.getImplementationRateBySeverity(Q);

            expect(rows.map((r) => r.severity)).toEqual([
                'critical',
                'high',
                'medium',
                'low',
            ]);
            expect(rows[0]).toMatchObject({ sent: 3, implemented: 1, rate: 0.33 });
            expect(rows[1]).toMatchObject({ sent: 1, implemented: 1, rate: 1 });
            expect(rows[2]).toMatchObject({ sent: 1, implemented: 1, rate: 1 });
            // low: s3,s6,s13,s14,s15 not + s9 impl → 6 sent 1 impl
            expect(rows[3]).toMatchObject({ sent: 6, implemented: 1, rate: 0.17 });
        });

        it('ignored criticals: only unimplemented criticals on closed PRs, newest first', async () => {
            const res = await service.getIgnoredCriticals(Q);

            expect(res.count).toBe(2);
            expect(res.items.map((i) => i.suggestionId)).toEqual(['s2', 's8']);
            expect(res.items[0]).toMatchObject({
                repository: 'org/api',
                prNumber: 101,
                summary: 'summary of s2',
            });
            // s10 (open PR) and s1 (implemented) must NOT appear
        });

        it('repositories health: per-repo rates, thumbs and weakest category', async () => {
            const rows = await service.getRepositoriesHealth(Q);

            expect(rows.map((r) => r.repository)).toEqual(['org/api', 'org/web']);

            // org/api: 2 PRs, 9 sent, 3 impl (s1,s4,s5) → 0.33
            // feedback: s3 ▼3, s6 ▼2, s5 ▲2 → up 2 / down 5
            // weakest: only code_style reaches the min-5 sample → rate 0
            expect(rows[0]).toMatchObject({
                prsReviewed: 2,
                suggestionsSent: 9,
                suggestionsImplemented: 3,
                implementationRate: 0.33,
                thumbsUp: 2,
                thumbsDown: 5,
                weakestCategory: { category: 'code_style', sent: 5, rate: 0 },
            });

            // org/web: 1 PR, 2 sent, 1 impl; s9 ▲1; no category reaches 5
            expect(rows[1]).toMatchObject({
                prsReviewed: 1,
                suggestionsSent: 2,
                implementationRate: 0.5,
                thumbsUp: 1,
                thumbsDown: 0,
                weakestCategory: null,
            });
        });

        it('kody rules usage: triggers, impl and feedback per rule', async () => {
            const rows = await service.getKodyRulesUsage(Q);

            expect(rows).toEqual([
                {
                    ruleId: 'rule-sec',
                    triggers: 2,
                    implemented: 1,
                    rate: 0.5,
                    thumbsUp: 0,
                    thumbsDown: 0,
                    lastTriggeredAt: '2026-05-19T10:00:00Z',
                },
                {
                    ruleId: 'rule-style',
                    triggers: 1,
                    implemented: 0,
                    rate: 0,
                    thumbsUp: 0,
                    thumbsDown: 2, // s6's downvotes follow the rule
                    lastTriggeredAt: '2026-05-26T10:00:00Z',
                },
            ]);
        });

        it('rules health use case: merges Mongo metadata and computes states', async () => {
            const kodyRulesService = {
                findByOrganizationId: jest.fn().mockResolvedValue({
                    rules: [
                        { uuid: 'rule-sec', title: 'Use parameterized queries', severity: 'high', repositoryId: 'global', status: KodyRulesStatus.ACTIVE },
                        { uuid: 'rule-style', title: 'No inline styles', severity: 'low', repositoryId: 'global', status: KodyRulesStatus.ACTIVE },
                        { uuid: 'rule-stale', title: 'Never triggered', severity: 'low', repositoryId: 'global', status: KodyRulesStatus.ACTIVE },
                    ],
                }),
            };
            const useCase = new GetKodyRulesHealthUseCase(
                service,
                kodyRulesService as never,
            );

            const rows = await useCase.execute(Q);

            expect(rows.map((r) => [r.ruleId, r.state])).toEqual([
                ['rule-sec', 'low_data'], // 2 triggers < min sample
                ['rule-style', 'low_data'],
                ['rule-stale', 'stale'], // active rule, zero triggers
            ]);
            expect(rows[0].title).toBe('Use parameterized queries');
        });

        it('negative feedback by category: joins labels, scoped to feedback window', async () => {
            const rows = await service.getNegativeFeedbackByCategory(Q);
            const byCat = Object.fromEntries(rows.map((r) => [r.category, r]));

            expect(rows[0].category).toBe('code_style'); // most downvoted first
            expect(byCat.code_style).toMatchObject({ thumbsUp: 0, thumbsDown: 5 });
            expect(byCat.error_handling).toMatchObject({ thumbsUp: 2, thumbsDown: 0 });
            expect(byCat.refactoring).toMatchObject({ thumbsUp: 1, thumbsDown: 0 });
            // org-2's 5 downvotes must not leak
            expect(rows.reduce((a, r) => a + r.thumbsDown, 0)).toBe(5);
        });

        it('negative feedback weekly: exact buckets', async () => {
            const rows = await service.getNegativeFeedbackWeekly(Q);

            expect(rows).toEqual([
                { weekStart: '2026-04-06', thumbsUp: 1, thumbsDown: 0 },
                { weekStart: '2026-05-18', thumbsUp: 0, thumbsDown: 3 },
                { weekStart: '2026-05-25', thumbsUp: 2, thumbsDown: 2 },
            ]);
        });

        it('negative vote rate highlight: current period totals', async () => {
            const res = await service.getNegativeVoteRateHighlight(Q);

            // up 3 (s5 ▲2 + s9 ▲1), down 5 (s3 ▼3 + s6 ▼2) → 5/8 = 0.63
            expect(res.currentPeriod).toEqual({
                thumbsUp: 3,
                thumbsDown: 5,
                negativeRate: 0.63,
            });
            expect(res.previousPeriod.thumbsDown).toBe(0);
        });

        it('suggestions explorer: filters, pagination and totals against real data', async () => {
            // all sent suggestions created in window (incl. s10 on the open PR)
            const all = await service.searchSuggestions(Q);
            expect(all.total).toBe(12);

            const criticals = await service.searchSuggestions({
                ...Q,
                severity: 'critical',
            });
            expect(criticals.total).toBe(4); // s1, s2, s8, s10
            expect(
                criticals.items.find((i) => i.suggestionId === 's10')?.prNumber,
            ).toBe(104);

            const web = await service.searchSuggestions({
                ...Q,
                repository: 'org/web',
            });
            expect(web.total).toBe(2);

            const notImpl = await service.searchSuggestions({
                ...Q,
                implementationStatus: 'not_implemented',
            });
            expect(notImpl.total).toBe(8); // s2,s3,s6,s13,s14,s15,s8,s10

            const styleNotImpl = await service.searchSuggestions({
                ...Q,
                category: 'code_style',
                implementationStatus: 'not_implemented',
            });
            expect(styleNotImpl.total).toBe(5);

            const page = await service.searchSuggestions({
                ...Q,
                pageSize: 5,
                page: 2,
            });
            expect(page.total).toBe(12);
            expect(page.items).toHaveLength(5);

            const search = await service.searchSuggestions({
                ...Q,
                search: 'summary of s8',
            });
            expect(search.total).toBe(1);
            expect(search.items[0].repository).toBe('org/web');

            // rule drill-down from the rules health table
            const byRule = await service.searchSuggestions({
                ...Q,
                ruleId: 'rule-sec',
            });
            expect(byRule.total).toBe(2); // s1, s2
            expect(
                byRule.items.map((i) => i.suggestionId).sort(),
            ).toEqual(['s1', 's2']);
        });
    },
);
