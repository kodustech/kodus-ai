/**
 * INTEGRATION TEST — the record of Kody's "changes requested" on a PR
 * (PullRequestsRepository.recordKodyChangeRequest / clearKodyChangeRequest /
 * findOpenPullRequestsWithKodyChangeRequest).
 *
 * The approval cron lists, on every pass, the PRs that carry the record, and
 * takes the request back once the findings behind it are resolved. The list
 * runs through a partial index, so it must find exactly the PRs with a record
 * and still answer on a deployment where the index was not built yet.
 *
 * Requires a running MongoDB — see resolveMongoTestGate.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { Model } from 'mongoose';

import {
    KODY_CHANGE_REQUEST_INDEX,
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import { resolveMongoTestGate } from '../mongo-test-uri';

const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test');

(shouldSkip ? describe.skip : describe)(
    "PullRequestsRepository — Kody's change request",
    () => {
        let repository: PullRequestsRepository;
        let model: Model<PullRequestsModel>;
        let module: TestingModule;

        const ORG = 'test-org-change-request-' + Date.now();
        const OTHER_ORG = ORG + '-other';
        const T1 = '2026-11-11T17:23:13.000Z';
        const T2 = '2026-11-11T19:44:00.000Z';

        const insertPr = (
            number: number,
            overrides: Record<string, unknown> = {},
        ) =>
            model.collection.insertOne({
                organizationId: ORG,
                number,
                status: 'open',
                provider: 'GITHUB',
                title: `PR ${number}`,
                repository: { id: 'repo-1', name: 'api' },
                files: [],
                ...overrides,
            });
        const stored = async (number: number, organizationId = ORG) =>
            (
                await model.collection.findOne({
                    organizationId,
                    number,
                    'repository.id': 'repo-1',
                })
            )?.kodyChangeRequest;
        const listed = async (organizationId = ORG) =>
            (
                await repository.findOpenPullRequestsWithKodyChangeRequest(
                    organizationId,
                )
            )
                .map((pr) => pr.number)
                .sort((a, b) => a - b);

        beforeAll(async () => {
            module = await Test.createTestingModule({
                imports: [
                    ConfigModule.forRoot(),
                    MongooseModule.forRoot(mongoUri),
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

            await insertPr(1);
            await insertPr(2);
            await insertPr(3, { status: 'closed' });
            // Same number in another repository and in another organization.
            await insertPr(1, { repository: { id: 'repo-2', name: 'web' } });
            await insertPr(1, { organizationId: OTHER_ORG });
        });

        afterAll(async () => {
            await model.deleteMany({
                organizationId: { $in: [ORG, OTHER_ORG] },
            });
            await module.close();
        });

        it('records a request on the PR of that repository and organization only', async () => {
            await expect(
                repository.recordKodyChangeRequest(ORG, 'repo-1', 1, {
                    requestedAt: T1,
                    commentIds: ['101', '102'],
                    summaryCommentId: 'd-1',
                }),
            ).resolves.toBe(true);

            expect(await stored(1)).toEqual({
                requestedAt: T1,
                commentIds: ['101', '102'],
                summaryCommentIds: ['d-1'],
            });
            expect(await stored(1, OTHER_ORG)).toBeUndefined();
            expect(
                (
                    await model.collection.findOne({
                        'organizationId': ORG,
                        'number': 1,
                        'repository.id': 'repo-2',
                    })
                )?.kodyChangeRequest,
            ).toBeUndefined();
        });

        it('answers false for a PR it has no record of', async () => {
            await expect(
                repository.recordKodyChangeRequest(ORG, 'repo-1', 999, {
                    requestedAt: T1,
                    commentIds: ['1'],
                }),
            ).resolves.toBe(false);
        });

        it('adds a second request to the first, without repeating a comment', async () => {
            await repository.recordKodyChangeRequest(ORG, 'repo-1', 1, {
                requestedAt: T2,
                commentIds: ['102', '103'],
            });

            expect(await stored(1)).toEqual({
                requestedAt: T2,
                commentIds: ['101', '102', '103'],
                summaryCommentIds: ['d-1'],
            });
        });

        it('lists the open PRs of the organization that carry a request', async () => {
            await repository.recordKodyChangeRequest(ORG, 'repo-1', 3, {
                requestedAt: T1,
                commentIds: ['301'],
            });
            await repository.recordKodyChangeRequest(OTHER_ORG, 'repo-1', 1, {
                requestedAt: T1,
                commentIds: ['901'],
            });

            // PR 2 has no request, PR 3 is closed.
            expect(await listed()).toEqual([1]);
            expect(await listed(OTHER_ORG)).toEqual([1]);

            const [pullRequest] =
                await repository.findOpenPullRequestsWithKodyChangeRequest(ORG);
            expect(pullRequest).toEqual({
                number: 1,
                provider: 'GITHUB',
                repository: { id: 'repo-1', name: 'api' },
                kodyChangeRequest: {
                    requestedAt: T2,
                    commentIds: ['101', '102', '103'],
                    summaryCommentIds: ['d-1'],
                },
            });
        });

        it('answers the same list on a deployment that lacks the index', async () => {
            const indexes = await model.collection.indexes();
            expect(indexes.map((index) => index.name)).toContain(
                KODY_CHANGE_REQUEST_INDEX,
            );

            await model.collection.dropIndex(KODY_CHANGE_REQUEST_INDEX);
            try {
                expect(await listed()).toEqual([1]);
            } finally {
                await model.syncIndexes();
            }
        });

        it('does not forget a request made again since it was read', async () => {
            await expect(
                repository.clearKodyChangeRequest(ORG, 'repo-1', 1, T1),
            ).resolves.toBe(false);

            expect((await stored(1))?.requestedAt).toBe(T2);
            expect(await listed()).toEqual([1]);
        });

        it('forgets the request it read, and stops listing the PR', async () => {
            await expect(
                repository.clearKodyChangeRequest(ORG, 'repo-1', 1, T2),
            ).resolves.toBe(true);

            expect(await stored(1)).toBeUndefined();
            expect(await listed()).toEqual([]);
        });
    },
);
