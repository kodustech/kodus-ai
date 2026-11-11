/**
 * INTEGRATION TEST — PullRequestsRepository.countDeliveredPullRequests with
 * `openOnly`, the "Needs attention" counter of the Reviews screen.
 *
 * The count hints the open-PR index. Left to choose, mongod also tries the
 * delivered-suggestion index, which leads to every PR that ever delivered a
 * suggestion; on a large organization that plan trial outran the time limit
 * and the counter came back as zero. The hint must not change WHAT is
 * counted, and a deployment without the index must still get its count.
 *
 * Requires a running MongoDB — see resolveMongoTestGate.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { Model } from 'mongoose';

import {
    OPEN_PULL_REQUESTS_INDEX,
    PULL_REQUEST_TITLE_INDEX,
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import { resolveMongoTestGate } from '../mongo-test-uri';

const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test');

(shouldSkip ? describe.skip : describe)(
    'PullRequestsRepository.countDeliveredPullRequests — open pull requests',
    () => {
        let repository: PullRequestsRepository;
        let model: Model<PullRequestsModel>;
        let module: TestingModule;

        const ORG = 'test-org-open-count-' + Date.now();
        const OTHER_ORG = ORG + '-other';

        const suggestion = (
            deliveryStatus: string,
            implementationStatus: string,
        ) => ({
            id: Math.random().toString(36),
            deliveryStatus,
            implementationStatus,
        });

        let nextNumber = 1;
        const insertPr = (overrides: Record<string, unknown>) =>
            model.collection.insertOne({
                organizationId: ORG,
                number: nextNumber++,
                repository: { id: 'repo-1', name: 'api' },
                status: 'open',
                merged: false,
                openedAt: new Date().toISOString(),
                user: { email: 'dev@example.com' },
                files: [
                    {
                        path: 'a.ts',
                        suggestions: [suggestion('sent', 'not_implemented')],
                    },
                ],
                ...overrides,
            });

        beforeAll(async () => {
            module = await Test.createTestingModule({
                imports: [
                    ConfigModule.forRoot(),
                    // monitorCommands: the tests below read the commands
                    // the repository actually sends.
                    MongooseModule.forRoot(mongoUri, { monitorCommands: true }),
                    MongooseModule.forFeature([
                        {
                            name: PullRequestsModel.name,
                            schema: PullRequestsSchema,
                        },
                    ]),
                ],
                providers: [PullRequestsRepository],
            }).compile();

            repository = module.get(PullRequestsRepository);
            model = module.get(getModelToken(PullRequestsModel.name));
            // autoIndex builds in the background; the hint needs it finished.
            await model.init();

            // Counted: open, in scope, with an unresolved delivered suggestion.
            // (PR numbers follow insertion order: 1, 2, 3, …)
            await insertPr({ title: 'Fix LOGIN redirect' });
            await insertPr({
                repository: { id: 'repo-2', name: 'web' },
                title: 'login: handle (api) .* edge',
            });
            await insertPr({
                // one resolved, one still open → still needs attention
                files: [
                    {
                        path: 'a.ts',
                        suggestions: [suggestion('sent', 'implemented')],
                    },
                    {
                        path: 'b.ts',
                        suggestions: [
                            suggestion('not_sent', 'not_implemented'),
                            suggestion('sent', 'not_implemented'),
                        ],
                    },
                ],
            });
            // Authored by somebody else, for the author filter.
            await insertPr({ user: { email: 'Lead@Example.com' } });

            // Not counted:
            await insertPr({ status: 'closed', title: 'Rework login form' });
            await insertPr({ merged: true });
            await insertPr({
                repository: { id: 'repo-out', name: 'x' },
                title: 'login outside the team',
            });
            await insertPr({
                files: [
                    {
                        path: 'a.ts',
                        suggestions: [suggestion('sent', 'implemented')],
                    },
                ],
            });
            await insertPr({
                files: [
                    {
                        path: 'a.ts',
                        suggestions: [
                            suggestion('not_sent', 'not_implemented'),
                        ],
                    },
                ],
            });
            await insertPr({ files: [] });
            await insertPr({
                organizationId: OTHER_ORG,
                title: 'login in another organization',
            });
        });

        afterAll(async () => {
            await model.deleteMany({
                organizationId: { $in: [ORG, OTHER_ORG] },
            });
            await module.close();
        });

        const count = (opts: { authorEmail?: string } = {}) =>
            repository.countDeliveredPullRequests(ORG, ['repo-1', 'repo-2'], {
                unresolvedOnly: true,
                openOnly: true,
                ...opts,
            });

        /** The count commands mongod received while `run` was in flight. */
        const countCommandsOf = async (run: () => Promise<unknown>) => {
            const commands: Array<{ hint?: unknown }> = [];
            const client = model.db.getClient();
            const onCommand = (event: {
                commandName: string;
                command: { aggregate?: string; hint?: unknown };
            }) => {
                if (
                    event.commandName === 'aggregate' &&
                    event.command.aggregate === model.collection.collectionName
                ) {
                    commands.push(event.command);
                }
            };
            client.on('commandStarted', onCommand);
            try {
                await run();
            } finally {
                client.off('commandStarted', onCommand);
            }
            return commands;
        };

        it('counts open pull requests that still carry an unresolved delivered suggestion', async () => {
            await expect(count()).resolves.toBe(4);
        });

        // What the fix changed. The counts above are the same before and
        // after it; the plan mongod is told to use is not.
        it('tells mongod to count through the open-PR index', async () => {
            const commands = await countCommandsOf(() => count());

            expect(commands).toHaveLength(1);
            expect(commands[0].hint).toBe(OPEN_PULL_REQUESTS_INDEX);
        });

        it('leaves the plan to mongod when the count is not limited to open PRs', async () => {
            const commands = await countCommandsOf(() =>
                repository.countDeliveredPullRequests(
                    ORG,
                    ['repo-1', 'repo-2'],
                    { unresolvedOnly: true },
                ),
            );

            expect(commands).toHaveLength(1);
            expect(commands[0].hint).toBeUndefined();
        });

        it('retries without the hint, once, on a deployment that lacks the index', async () => {
            await model.collection.dropIndex(OPEN_PULL_REQUESTS_INDEX);
            try {
                const commands = await countCommandsOf(() => count());

                expect(commands.map((command) => command.hint)).toEqual([
                    OPEN_PULL_REQUESTS_INDEX,
                    undefined,
                ]);
            } finally {
                await model.syncIndexes();
            }
        });

        it('narrows to one author, case-insensitively', async () => {
            await expect(
                count({ authorEmail: 'lead@example.com' }),
            ).resolves.toBe(1);
        });

        it('answers the same count on a deployment that lacks the index', async () => {
            const indexes = await model.collection.indexes();
            expect(indexes.map((index) => index.name)).toContain(
                OPEN_PULL_REQUESTS_INDEX,
            );

            await model.collection.dropIndex(OPEN_PULL_REQUESTS_INDEX);
            try {
                await expect(count()).resolves.toBe(4);
            } finally {
                await model.syncIndexes();
            }
        });

        describe('findOpenPullRequestKeys', () => {
            const SCOPE = ['repo-1', 'repo-2'];
            const numbers = (result: { keys: Array<{ number: number }> }) =>
                result.keys.map((key) => key.number).sort((a, b) => a - b);

            it('answers the PRs the "needs attention" count counts', async () => {
                const result = await repository.findOpenPullRequestKeys(
                    ORG,
                    SCOPE,
                    { unresolvedOnly: true, limit: 100 },
                );

                expect(numbers(result)).toEqual([1, 2, 3, 4]);
                expect(result.truncated).toBe(false);
                expect(result.keys).toContainEqual({
                    number: 2,
                    repositoryId: 'repo-2',
                });
                await expect(count()).resolves.toBe(result.keys.length);
            });

            it('answers every open PR in scope without the suggestion condition', async () => {
                const inScope = await repository.findOpenPullRequestKeys(
                    ORG,
                    SCOPE,
                    { limit: 100 },
                );
                // 8, 9 and 10 are open but carry nothing unresolved.
                expect(numbers(inScope)).toEqual([1, 2, 3, 4, 8, 9, 10]);

                const wholeOrganization =
                    await repository.findOpenPullRequestKeys(ORG, undefined, {
                        limit: 100,
                    });
                expect(numbers(wholeOrganization)).toEqual([
                    1, 2, 3, 4, 7, 8, 9, 10,
                ]);
            });

            it('says when there are more than it was asked for', async () => {
                const exact = await repository.findOpenPullRequestKeys(
                    ORG,
                    SCOPE,
                    { limit: 7 },
                );
                expect(exact.truncated).toBe(false);
                expect(exact.keys).toHaveLength(7);

                const short = await repository.findOpenPullRequestKeys(
                    ORG,
                    SCOPE,
                    { limit: 6 },
                );
                expect(short.truncated).toBe(true);
                expect(short.keys).toHaveLength(6);
            });

            it('answers the same keys on a deployment that lacks the index', async () => {
                await model.collection.dropIndex(OPEN_PULL_REQUESTS_INDEX);
                try {
                    const result = await repository.findOpenPullRequestKeys(
                        ORG,
                        SCOPE,
                        { unresolvedOnly: true, limit: 100 },
                    );
                    expect(numbers(result)).toEqual([1, 2, 3, 4]);
                } finally {
                    await model.syncIndexes();
                }
            });
        });

        describe('findPRNumbersByTitleAndOrganization', () => {
            const search = (title: string, repositoryIds?: string[]) =>
                repository
                    .findPRNumbersByTitleAndOrganization(
                        title,
                        ORG,
                        repositoryIds,
                    )
                    .then((keys) => keys.sort((a, b) => a.number - b.number));

            it('matches the title anywhere, whatever the case, within the scope', async () => {
                await expect(
                    search('login', ['repo-1', 'repo-2']),
                ).resolves.toEqual([
                    { number: 1, repositoryId: 'repo-1' },
                    { number: 2, repositoryId: 'repo-2' },
                    { number: 5, repositoryId: 'repo-1' },
                ]);

                // No scope: the organization's PRs, never another organization's.
                await expect(search('LOGIN')).resolves.toEqual([
                    { number: 1, repositoryId: 'repo-1' },
                    { number: 2, repositoryId: 'repo-2' },
                    { number: 5, repositoryId: 'repo-1' },
                    { number: 7, repositoryId: 'repo-out' },
                ]);
            });

            it('treats what was typed as text, not as a pattern', async () => {
                await expect(search('(api) .*')).resolves.toEqual([
                    { number: 2, repositoryId: 'repo-2' },
                ]);
                await expect(search('.*')).resolves.toEqual([
                    { number: 2, repositoryId: 'repo-2' },
                ]);
            });

            it('is answered from the title index without loading a document', async () => {
                const plan = await model.collection
                    .find(
                        {
                            organizationId: ORG,
                            title: { $regex: 'login', $options: 'i' },
                        },
                        {
                            projection: {
                                'number': 1,
                                'repository.id': 1,
                                '_id': 0,
                            },
                        },
                    )
                    .hint(PULL_REQUEST_TITLE_INDEX)
                    .explain('executionStats');

                expect(plan.executionStats.nReturned).toBe(4);
                expect(plan.executionStats.totalDocsExamined).toBe(0);
            });

            it('answers the same PRs on a deployment that lacks the index', async () => {
                await model.collection.dropIndex(PULL_REQUEST_TITLE_INDEX);
                try {
                    await expect(
                        search('login', ['repo-1', 'repo-2']),
                    ).resolves.toEqual([
                        { number: 1, repositoryId: 'repo-1' },
                        { number: 2, repositoryId: 'repo-2' },
                        { number: 5, repositoryId: 'repo-1' },
                    ]);
                } finally {
                    await model.syncIndexes();
                }
            });
        });
    },
);
