/**
 * Reads that name pull requests by (repository, number) pairs. A PR number is
 * only unique within a repository, so each read must answer for the pairs it
 * was given and no other, and must reach them through the unique
 * (number, repository.id, organizationId) index instead of one `$or` branch
 * per pair (the shape that hit maxIndexedOrSolutionsReached in production).
 *
 * Runs against a REAL MongoDB in a throwaway database.
 */
import mongoose, { Connection, Model } from 'mongoose';

import { PullRequestsRepository } from './pullRequests.repository';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from './schemas/pullRequests.model';
import { resolveMongoTestGate } from '../../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it, fails in CI
// when the URI is missing instead of passing with nothing asserted.
// No API_MG_DB_HOST fallback: that is a docker-network hostname that never
// resolves from the host, so a local .env carrying it must skip, not fail.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'kodus_pr_pair_reads_it';
const ORG = 'org-pairs-it';

const suggestion = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    deliveryStatus: 'sent',
    severity: 'high',
    label: 'bug',
    implementationStatus: 'not_implemented',
    comment: { id: `c-${id}` },
    ...over,
});

const pr = (repositoryId: string, number: number, suggestions: any[]) => ({
    organizationId: ORG,
    number,
    title: `PR ${number}`,
    status: 'open',
    provider: 'github',
    repository: { id: repositoryId, name: `repo-${repositoryId}` },
    files: [
        { id: `f-${repositoryId}-${number}`, path: 'src/a.ts', suggestions },
    ],
});

let connection: Connection | null = null;
let available = false;

(gate.shouldSkip ? describe.skip : describe)(
    'pull request reads by (repository, number) pairs (real MongoDB)',
    () => {
        let model: Model<PullRequestsModel>;
        let repository: PullRequestsRepository;

        beforeAll(async () => {
            const uri = gate.mongoUri;
            connection = await mongoose
                .createConnection(uri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 2000,
                })
                .asPromise();
            available = true;
            await connection.dropDatabase();
            model = connection.model<PullRequestsModel>(
                PullRequestsModel.name,
                PullRequestsSchema,
            );
            await model.init();
            await model.collection.insertMany([
                // Repository A, PR 1: two delivered, one filtered.
                pr('A', 1, [
                    suggestion('a1-1'),
                    suggestion('a1-2', { severity: 'critical' }),
                    suggestion('a1-3', { deliveryStatus: 'not_sent' }),
                ]),
                // Repository A, PR 2: one delivered.
                pr('A', 2, [suggestion('a2-1')]),
                // Repository B shares both numbers with A.
                pr('B', 1, [suggestion('b1-1', { severity: 'low' })]),
                pr('B', 2, []),
            ] as any[]);
            repository = new PullRequestsRepository(model as any);
        }, 30_000);

        afterAll(async () => {
            if (connection) {
                if (available) await connection.dropDatabase();
                await connection.close();
            }
        });

        it('counts suggestions for the pairs asked, not for a same-numbered PR elsewhere', async () => {
            const counts =
                await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                    [
                        { repositoryId: 'A', number: 1 },
                        { repositoryId: 'B', number: 2 },
                    ],
                    ORG,
                );

            expect([...counts.keys()].sort()).toEqual(['A_1', 'B_2']);
            expect(counts.get('A_1')).toMatchObject({
                sent: 2,
                filtered: 1,
                bySeverity: { critical: 1, high: 1, medium: 0, low: 0 },
                unresolved: 2,
                categories: ['bug'],
            });
            expect(counts.get('B_2')).toMatchObject({ sent: 0, filtered: 0 });
        });

        it('reaches the pairs through the unique index, without an OR plan', async () => {
            const aggregate = jest.spyOn(model, 'aggregate');
            await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                [
                    { repositoryId: 'A', number: 1 },
                    { repositoryId: 'B', number: 2 },
                ],
                ORG,
            );
            const pipeline = aggregate.mock.calls[0][0] as any[];
            aggregate.mockRestore();

            const plan = JSON.stringify(
                await model.collection
                    .aggregate(pipeline)
                    .explain('queryPlanner'),
            );

            expect(plan).toContain('IXSCAN');
            expect(plan).not.toMatch(/"stage":"(OR|SUBPLAN)"/);
        });

        it('reads delivered suggestions only from the repositories given', async () => {
            const found =
                await repository.findPullRequestsWithDeliveredSuggestions(
                    ORG,
                    [1],
                    'open',
                    ['A'],
                );

            expect(found.map((p) => `${p.repository.id}:${p.number}`)).toEqual([
                'A:1',
            ]);
            expect(found[0].suggestions.map((s) => s.id).sort()).toEqual([
                'a1-1',
                'a1-2',
            ]);
        });

        it('still reads every repository when the caller names none', async () => {
            const found =
                await repository.findPullRequestsWithDeliveredSuggestions(
                    ORG,
                    [1],
                    'open',
                );

            expect(
                found.map((p) => `${p.repository.id}:${p.number}`).sort(),
            ).toEqual(['A:1', 'B:1']);
        });

        it('finds PRs with no delivered suggestion for the exact pairs asked', async () => {
            const found =
                await repository.findPullRequestsWithoutDeliveredSuggestionsForApproval(
                    ORG,
                    [
                        { repositoryId: 'B', pullRequestNumber: 2 },
                        // Has delivered suggestions: not returned.
                        { repositoryId: 'A', pullRequestNumber: 2 },
                    ],
                    'open',
                );

            // A:2 has suggestions and B:1 was not asked for, though both match
            // the numbers and repositories asked.
            expect(found.map((p) => `${p.repository.id}:${p.number}`)).toEqual([
                'B:2',
            ]);
        });

        it('returns nothing for pairs whose numbers and repositories cross into one never asked', async () => {
            // A:2 and B:1 both have delivered suggestions. Their numbers and
            // repositories also name B:2, which has none: a read admitting
            // the cross product would return it.
            const found =
                await repository.findPullRequestsWithoutDeliveredSuggestionsForApproval(
                    ORG,
                    [
                        { repositoryId: 'A', pullRequestNumber: 2 },
                        { repositoryId: 'B', pullRequestNumber: 1 },
                    ],
                    'open',
                );

            expect(found).toEqual([]);
        });

        // Every read below names A:2 and B:1, whose numbers and repositories
        // also cross into A:1 and B:2: only the two pairs asked may be read.
        const crossing = [
            { repositoryId: 'A', number: 2 },
            { repositoryId: 'B', number: 1 },
        ];
        const docsExamined = async (
            run: () => Promise<unknown>,
            method: 'find' | 'aggregate',
        ) => {
            const spy = jest.spyOn(model, method as any);
            await run();
            const calls = spy.mock.calls.map((call) => call[0]);
            spy.mockRestore();
            let total = 0;
            for (const arg of calls) {
                const explained: any =
                    method === 'find'
                        ? await model.collection
                              .find(arg as any)
                              .explain('executionStats')
                        : await model.collection
                              .aggregate(arg as any[])
                              .explain('executionStats');
                const stats =
                    explained.executionStats ??
                    explained.stages?.[0]?.$cursor?.executionStats;
                total += stats.totalDocsExamined;
            }
            return total;
        };

        it('reads only the pairs asked for the suggestion counts', async () => {
            expect(
                await docsExamined(
                    () =>
                        repository.findSuggestionCountsByNumbersAndRepositoryIds(
                            crossing,
                            ORG,
                        ),
                    'aggregate',
                ),
            ).toBe(2);
        });

        it('reads only the pairs asked for the PR list', async () => {
            expect(
                await docsExamined(
                    () =>
                        repository.findManyByNumbersAndRepositoryIds(
                            crossing,
                            ORG,
                        ),
                    'find',
                ),
            ).toBe(2);
        });

        it('reads only the pairs asked for the approval cron', async () => {
            expect(
                await docsExamined(
                    () =>
                        repository.findPullRequestsWithoutDeliveredSuggestionsForApproval(
                            ORG,
                            crossing.map((c) => ({
                                repositoryId: c.repositoryId,
                                pullRequestNumber: c.number,
                            })),
                            'open',
                        ),
                    'find',
                ),
            ).toBe(2);
        });
    },
);
