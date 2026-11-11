/**
 * INTEGRATION TEST — the pull request list queries of
 * AutomationExecutionRepository against a real Postgres.
 *
 * These queries are the Reviews screen: which executions a team sees, in what
 * order, and how many. The unit spec mocks the query builder, so it cannot
 * tell a query that returns the wrong rows from one that returns the right
 * ones — this file can.
 *
 * Locally, an unreachable Postgres skips the suite with a warning, like
 * user.repository.integration.spec.ts. In CI it fails.
 */
require('dotenv').config();

import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AutomationExecutionRepository } from './automationExecution.repository';
import { AutomationExecutionModel } from './schemas/automationExecution.model';

import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';

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
    entities: ENTITIES,
});

/** Postgres not running or not reachable: skip. Anything else must fail. */
const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

type Seeded = { uuid: string; createdAt: string };

(skipIntegration ? describe.skip : describe)(
    'AutomationExecutionRepository pull request list (integration, real Postgres)',
    () => {
        let canRun = true;
        let repository: AutomationExecutionRepository;

        const org = randomUUID();
        const otherOrg = randomUUID();
        const team = randomUUID();
        const siblingTeam = randomUUID();
        const otherOrgTeam = randomUUID();
        // The team's code review automation, plus a second automation of the
        // same team that never touched a pull request.
        const reviewAutomation = randomUUID();
        const idleAutomation = randomUUID();
        const siblingAutomation = randomUUID();
        const otherOrgAutomation = randomUUID();
        // A team whose pull request executions are split over two automations.
        const splitTeam = randomUUID();
        const splitAutomationA = randomUUID();
        const splitAutomationB = randomUUID();

        const REPO_API = '9100000001';
        const REPO_WEB = '9100000002';

        const at = (minutes: number) =>
            new Date(Date.UTC(2026, 0, 1, 12, minutes, 0)).toISOString();

        const insertExecution = async (row: {
            automation: string;
            createdAt: string;
            status?: string;
            repositoryId?: string | null;
            pullRequestNumber?: number | null;
            reviewed?: boolean;
            uuid?: string;
        }): Promise<Seeded> => {
            const uuid = row.uuid ?? randomUUID();
            await dataSource.query(
                `INSERT INTO automation_execution
                    (uuid, "createdAt", "updatedAt", status, "dataExecution",
                     "pullRequestNumber", "repositoryId", team_automation_id, origin)
                 VALUES ($1, $2, $2, $3, $4, $5, $6, $7, 'webhook')`,
                [
                    uuid,
                    row.createdAt,
                    row.status ?? 'success',
                    JSON.stringify({ repository: { name: 'api' } }),
                    row.pullRequestNumber === undefined
                        ? 1
                        : row.pullRequestNumber,
                    row.repositoryId === undefined
                        ? REPO_API
                        : row.repositoryId,
                    row.automation,
                ],
            );
            if (row.reviewed ?? true) {
                await dataSource.query(
                    `INSERT INTO code_review_execution
                        (uuid, status, stage_name, automation_execution_id)
                     VALUES ($1, 'success', 'stage', $2), ($3, 'success', 'stage-2', $2)`,
                    [randomUUID(), uuid, randomUUID()],
                );
            }
            return { uuid, createdAt: row.createdAt };
        };

        // Named after what each row is, newest first.
        const rows = {} as Record<
            | 'apiPr7Error'
            | 'webPr3Success'
            | 'apiPr7Success'
            | 'apiPr5Partial'
            | 'tieHigh'
            | 'tieLow'
            | 'apiPr2Old',
            Seeded
        >;

        const list = (
            params: Partial<
                Parameters<
                    AutomationExecutionRepository['findPullRequestExecutionsByOrganizationAndTeam']
                >[0]
            > = {},
        ) =>
            repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: { organizationId: org, teamId: team },
                ...params,
            });

        const uuids = (result: { data: Array<{ uuid?: string }> }) =>
            result.data.map((execution) => execution.uuid);

        beforeAll(async () => {
            try {
                await dataSource.initialize();
            } catch (error) {
                const code = (error as { code?: string })?.code ?? '';
                // CI always has Postgres (tests.yml): there, an unreachable
                // database is a failure, not a reason to report green having
                // run no query. SKIP_INTEGRATION is the way to opt out.
                if (UNREACHABLE.has(code) && !process.env.CI) {
                    canRun = false;
                    console.warn(
                        `[integration] Postgres unreachable (${code}): the pull request list queries were NOT exercised.`,
                    );
                    return;
                }
                throw error;
            }

            repository = new AutomationExecutionRepository(
                dataSource.getRepository(AutomationExecutionModel),
            );

            await dataSource.query(
                `INSERT INTO organizations (uuid, name) VALUES ($1, 'it-org'), ($2, 'it-other-org')`,
                [org, otherOrg],
            );
            await dataSource.query(
                `INSERT INTO teams (uuid, name, organization_id) VALUES
                    ($1, 'it-team', $5), ($2, 'it-sibling', $5),
                    ($3, 'it-other-org-team', $6), ($4, 'it-split', $5)`,
                [team, siblingTeam, otherOrgTeam, splitTeam, org, otherOrg],
            );
            await dataSource.query(
                `INSERT INTO team_automations (uuid, "teamUuid") VALUES
                    ($1, $7), ($2, $7), ($3, $8), ($4, $9), ($5, $10), ($6, $10)`,
                [
                    reviewAutomation,
                    idleAutomation,
                    siblingAutomation,
                    otherOrgAutomation,
                    splitAutomationA,
                    splitAutomationB,
                    team,
                    siblingTeam,
                    otherOrgTeam,
                    splitTeam,
                ],
            );

            rows.apiPr7Error = await insertExecution({
                automation: reviewAutomation,
                createdAt: at(50),
                status: 'error',
                pullRequestNumber: 7,
            });
            rows.webPr3Success = await insertExecution({
                automation: reviewAutomation,
                createdAt: at(40),
                repositoryId: REPO_WEB,
                pullRequestNumber: 3,
            });
            rows.apiPr7Success = await insertExecution({
                automation: reviewAutomation,
                createdAt: at(30),
                pullRequestNumber: 7,
            });
            rows.apiPr5Partial = await insertExecution({
                automation: reviewAutomation,
                createdAt: at(20),
                status: 'partial_error',
                pullRequestNumber: 5,
            });
            // Same createdAt: the uuid is the tie-break, descending.
            rows.tieHigh = await insertExecution({
                automation: reviewAutomation,
                createdAt: at(10),
                pullRequestNumber: 4,
                uuid: 'ffffffff-0000-4000-8000-000000000001',
            });
            rows.tieLow = await insertExecution({
                automation: reviewAutomation,
                createdAt: at(10),
                pullRequestNumber: 4,
                uuid: '00000000-0000-4000-8000-000000000001',
            });
            rows.apiPr2Old = await insertExecution({
                automation: reviewAutomation,
                createdAt: at(0),
                pullRequestNumber: 2,
            });

            // Never part of the reviewed list:
            // skipped before any review stage ran (PR 9: skipped only).
            await insertExecution({
                automation: reviewAutomation,
                createdAt: at(45),
                status: 'skipped',
                pullRequestNumber: 9,
                reviewed: false,
            });
            await insertExecution({
                automation: reviewAutomation,
                createdAt: at(46),
                status: 'skipped',
                pullRequestNumber: 9,
                reviewed: false,
            });
            // PR 7 was skipped once too, but it has reviewed runs.
            await insertExecution({
                automation: reviewAutomation,
                createdAt: at(25),
                status: 'skipped',
                pullRequestNumber: 7,
                reviewed: false,
            });
            // not a pull request execution
            await insertExecution({
                automation: reviewAutomation,
                createdAt: at(55),
                pullRequestNumber: null,
                repositoryId: null,
            });
            await insertExecution({
                automation: idleAutomation,
                createdAt: at(56),
                pullRequestNumber: null,
                repositoryId: null,
            });
            // another team of the same organization
            await insertExecution({
                automation: siblingAutomation,
                createdAt: at(57),
                pullRequestNumber: 7,
            });
            // another organization
            await insertExecution({
                automation: otherOrgAutomation,
                createdAt: at(58),
                pullRequestNumber: 7,
            });

            // The split team: newest and oldest on A, middle on B.
            await insertExecution({
                automation: splitAutomationA,
                createdAt: at(30),
                pullRequestNumber: 31,
                uuid: 'aaaaaaaa-0000-4000-8000-000000000003',
            });
            await insertExecution({
                automation: splitAutomationB,
                createdAt: at(20),
                pullRequestNumber: 32,
                uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
            });
            await insertExecution({
                automation: splitAutomationA,
                createdAt: at(10),
                pullRequestNumber: 33,
                uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
            });
        });

        afterAll(async () => {
            if (!dataSource.isInitialized) return;
            const automations = [
                reviewAutomation,
                idleAutomation,
                siblingAutomation,
                otherOrgAutomation,
                splitAutomationA,
                splitAutomationB,
            ];
            await dataSource.query(
                `DELETE FROM code_review_execution WHERE automation_execution_id IN
                    (SELECT uuid FROM automation_execution WHERE team_automation_id = ANY($1::uuid[]))`,
                [automations],
            );
            await dataSource.query(
                `DELETE FROM automation_execution WHERE team_automation_id = ANY($1::uuid[])`,
                [automations],
            );
            await dataSource.query(
                `DELETE FROM team_automations WHERE uuid = ANY($1::uuid[])`,
                [automations],
            );
            await dataSource.query(
                `DELETE FROM teams WHERE uuid = ANY($1::uuid[])`,
                [[team, siblingTeam, otherOrgTeam, splitTeam]],
            );
            await dataSource.query(
                `DELETE FROM organizations WHERE uuid = ANY($1::uuid[])`,
                [[org, otherOrg]],
            );
            await dataSource.destroy();
        });

        const reviewedNewestFirst = () => [
            rows.apiPr7Error.uuid,
            rows.webPr3Success.uuid,
            rows.apiPr7Success.uuid,
            rows.apiPr5Partial.uuid,
            rows.tieHigh.uuid,
            rows.tieLow.uuid,
            rows.apiPr2Old.uuid,
        ];

        it('lists only the team’s reviewed pull request executions, newest first', async () => {
            if (!canRun) return;

            const result = await list();

            expect(uuids(result)).toEqual(reviewedNewestFirst());
            expect(result.data[0]).toMatchObject({
                status: 'error',
                pullRequestNumber: 7,
                repositoryId: REPO_API,
                dataExecution: { repository: { name: 'api' } },
            });
        });

        it('pages by limit and continues from a cursor without repeating or skipping rows', async () => {
            if (!canRun) return;

            const firstPage = await list({ take: 3 });
            expect(uuids(firstPage)).toEqual(reviewedNewestFirst().slice(0, 3));

            const next = await list({
                take: 3,
                cursor: {
                    createdAt: rows.apiPr7Success.createdAt,
                    uuid: rows.apiPr7Success.uuid,
                },
            });
            expect(uuids(next)).toEqual(reviewedNewestFirst().slice(3, 6));

            // A cursor in the middle of two rows that share a timestamp.
            const afterTie = await list({
                cursor: {
                    createdAt: rows.tieHigh.createdAt,
                    uuid: rows.tieHigh.uuid,
                },
            });
            expect(uuids(afterTie)).toEqual([
                rows.tieLow.uuid,
                rows.apiPr2Old.uuid,
            ]);
        });

        it('honours the offset for callers that still page by number', async () => {
            if (!canRun) return;

            const result = await list({
                skip: 5,
                take: 30,
            });

            expect(uuids(result)).toEqual(reviewedNewestFirst().slice(5));
        });

        it('filters by repository, status, pull request number, date and PR keys', async () => {
            if (!canRun) return;

            expect(
                uuids(
                    await list({
                        repositoryIds: [REPO_WEB],
                    }),
                ),
            ).toEqual([rows.webPr3Success.uuid]);

            expect(
                uuids(
                    await list({
                        repositoryIds: [REPO_API, REPO_WEB],
                        status: 'error',
                    }),
                ),
            ).toEqual([rows.apiPr7Error.uuid]);

            expect(uuids(await list({ pullRequestNumber: 7 }))).toEqual([
                rows.apiPr7Error.uuid,
                rows.apiPr7Success.uuid,
            ]);

            expect(
                uuids(
                    await list({
                        createdAtFrom: at(15),
                        createdAtTo: at(35),
                    }),
                ),
            ).toEqual([rows.apiPr7Success.uuid, rows.apiPr5Partial.uuid]);

            expect(
                uuids(
                    await list({
                        prFilters: [
                            { number: 3, repositoryId: REPO_WEB },
                            { number: 2, repositoryId: REPO_API },
                        ],
                    }),
                ),
            ).toEqual([rows.webPr3Success.uuid, rows.apiPr2Old.uuid]);
        });

        it('reads pull request keys as a set: order, repeats and strangers do not matter', async () => {
            if (!canRun) return;

            const wanted = [
                rows.apiPr7Error.uuid,
                rows.webPr3Success.uuid,
                rows.apiPr7Success.uuid,
            ];

            const result = await list({
                prFilters: [
                    { number: 3, repositoryId: REPO_WEB },
                    { number: 7, repositoryId: REPO_API },
                    // repeated
                    { number: 7, repositoryId: REPO_API },
                    // right number, wrong repository
                    { number: 7, repositoryId: REPO_WEB },
                    // no such pull request
                    { number: 4242, repositoryId: REPO_API },
                    // only ever skipped: it has no reviewed execution
                    { number: 9, repositoryId: REPO_API },
                ],
            });
            expect(uuids(result)).toEqual(wanted);

            // A key list far longer than the team's history.
            const many = await list({
                prFilters: [
                    ...Array.from({ length: 3000 }, (_, i) => ({
                        number: 100_000 + i,
                        repositoryId: REPO_API,
                    })),
                    { number: 2, repositoryId: REPO_API },
                ],
            });
            expect(uuids(many)).toEqual([rows.apiPr2Old.uuid]);

            const none = await list({
                prFilters: [{ number: 4242, repositoryId: REPO_API }],
            });
            expect(none.data).toEqual([]);
        });

        it('combines pull request keys with the other filters, paging and totals', async () => {
            if (!canRun) return;

            const keys = [
                { number: 7, repositoryId: REPO_API },
                { number: 5, repositoryId: REPO_API },
                { number: 4, repositoryId: REPO_API },
            ];

            const errorsOnly = await list({
                prFilters: keys,
                status: 'error',
            });
            expect(uuids(errorsOnly)).toEqual([rows.apiPr7Error.uuid]);

            const afterCursor = await list({
                prFilters: keys,
                take: 2,
                cursor: {
                    createdAt: rows.apiPr7Success.createdAt,
                    uuid: rows.apiPr7Success.uuid,
                },
            });
            expect(uuids(afterCursor)).toEqual([
                rows.apiPr5Partial.uuid,
                rows.tieHigh.uuid,
            ]);

            const totals = await list({ countOnly: true, prFilters: keys });
            // PR 7 twice, PR 5 once, PR 4 twice.
            expect(totals).toEqual({ data: [], total: 5, distinctPrTotal: 3 });
        });

        it('does not let a pull request key reach another team’s execution', async () => {
            if (!canRun) return;

            // PR 7 of the same repository exists on the sibling team and on
            // another organization.
            const sibling =
                await repository.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        organizationAndTeamData: {
                            organizationId: org,
                            teamId: siblingTeam,
                        },
                        prFilters: [{ number: 7, repositoryId: REPO_API }],
                    },
                );
            expect(sibling.data).toHaveLength(1);
            expect(uuids(sibling)).not.toContain(rows.apiPr7Error.uuid);

            const split =
                await repository.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        organizationAndTeamData: {
                            organizationId: org,
                            teamId: splitTeam,
                        },
                        prFilters: [
                            { number: 31, repositoryId: REPO_API },
                            { number: 33, repositoryId: REPO_API },
                            { number: 7, repositoryId: REPO_API },
                        ],
                    },
                );
            // Both automations of the split team, and nothing of PR 7.
            expect(uuids(split)).toEqual([
                'aaaaaaaa-0000-4000-8000-000000000003',
                'aaaaaaaa-0000-4000-8000-000000000001',
            ]);
        });

        it('counts executions and distinct pull requests over the same filters', async () => {
            if (!canRun) return;

            const all = await list({ countOnly: true });
            expect(all.total).toBe(7);
            // PRs 7, 3, 5, 4, 2 — PR 9 was only ever skipped.
            expect(all.distinctPrTotal).toBe(5);

            const filtered = await list({
                countOnly: true,
                repositoryIds: [REPO_API],
            });
            expect(filtered.total).toBe(6);
            expect(filtered.distinctPrTotal).toBe(4);

            // A page reads its rows and counts nothing.
            const page = await list({ take: 2 });
            expect(page.data).toHaveLength(2);
            expect(page.total).toBe(0);
        });

        it('answers only the totals when asked to count', async () => {
            if (!canRun) return;

            const totals = await list({ countOnly: true });
            expect(totals).toEqual({ data: [], total: 7, distinctPrTotal: 5 });

            const errors = await list({ countOnly: true, status: 'error' });
            expect(errors).toEqual({ data: [], total: 1, distinctPrTotal: 1 });

            const nothing = await list({
                countOnly: true,
                pullRequestNumber: 999,
            });
            expect(nothing).toEqual({ data: [], total: 0, distinctPrTotal: 0 });
        });

        it('never crosses the team or the organization', async () => {
            if (!canRun) return;

            const sibling =
                await repository.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        organizationAndTeamData: {
                            organizationId: org,
                            teamId: siblingTeam,
                        },
                    },
                );
            expect(sibling.data).toHaveLength(1);

            // The team exists, but not under this organization.
            const wrongOrganization =
                await repository.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        organizationAndTeamData: {
                            organizationId: otherOrg,
                            teamId: team,
                        },
                    },
                );
            expect(wrongOrganization).toEqual({
                data: [],
                total: 0,
                distinctPrTotal: 0,
            });

            const unknownTeam =
                await repository.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        organizationAndTeamData: {
                            organizationId: org,
                            teamId: randomUUID(),
                        },
                    },
                );
            expect(unknownTeam.data).toEqual([]);
        });

        it('keeps one newest-first order when the team has executions on two automations', async () => {
            if (!canRun) return;

            const scope = {
                organizationAndTeamData: {
                    organizationId: org,
                    teamId: splitTeam,
                },
            };
            const result =
                await repository.findPullRequestExecutionsByOrganizationAndTeam(
                    scope,
                );

            expect(uuids(result)).toEqual([
                'aaaaaaaa-0000-4000-8000-000000000003',
                'aaaaaaaa-0000-4000-8000-000000000002',
                'aaaaaaaa-0000-4000-8000-000000000001',
            ]);
            await expect(
                repository.findPullRequestExecutionsByOrganizationAndTeam({
                    ...scope,
                    countOnly: true,
                }),
            ).resolves.toMatchObject({ total: 3, distinctPrTotal: 3 });

            const afterFirst =
                await repository.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        ...scope,
                        cursor: {
                            createdAt: at(30),
                            uuid: 'aaaaaaaa-0000-4000-8000-000000000003',
                        },
                    },
                );
            expect(uuids(afterFirst)).toEqual([
                'aaaaaaaa-0000-4000-8000-000000000002',
                'aaaaaaaa-0000-4000-8000-000000000001',
            ]);
        });

        it('groups reviewed pull requests and flags the ones with a failed run', async () => {
            if (!canRun) return;

            const keys = await repository.getDistinctReviewedPullRequestKeys({
                organizationAndTeamData: { organizationId: org, teamId: team },
                repositoryIds: [REPO_API, REPO_WEB],
            });

            const byKey = new Map(
                keys.map((key) => [
                    `${key.repositoryId}#${key.pullRequestNumber}`,
                    key.hasError,
                ]),
            );
            expect(byKey).toEqual(
                new Map([
                    [`${REPO_API}#7`, true],
                    [`${REPO_WEB}#3`, false],
                    [`${REPO_API}#5`, true],
                    [`${REPO_API}#4`, false],
                    [`${REPO_API}#2`, false],
                ]),
            );

            const fromRecent =
                await repository.getDistinctReviewedPullRequestKeys({
                    organizationAndTeamData: {
                        organizationId: org,
                        teamId: team,
                    },
                    repositoryIds: [REPO_API],
                    createdAtFrom: at(25),
                });
            expect(
                fromRecent.map((key) => key.pullRequestNumber).sort(),
            ).toEqual([7]);
        });

        it('lists as awaiting only pull requests whose every run was skipped', async () => {
            if (!canRun) return;

            const awaiting = await repository.getAwaitingReviewPullRequestKeys({
                organizationAndTeamData: { organizationId: org, teamId: team },
                repositoryIds: [REPO_API, REPO_WEB],
            });

            // PR 7 has a skipped run as well, but it was reviewed.
            expect(awaiting).toEqual([
                { repositoryId: REPO_API, pullRequestNumber: 9 },
            ]);

            const otherRepository =
                await repository.getAwaitingReviewPullRequestKeys({
                    organizationAndTeamData: {
                        organizationId: org,
                        teamId: team,
                    },
                    repositoryIds: [REPO_WEB],
                });
            expect(otherRepository).toEqual([]);
        });
    },
);
