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

            // Counted: open, in scope, with an unresolved delivered suggestion.
            await insertPr({});
            await insertPr({ repository: { id: 'repo-2', name: 'web' } });
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
            await insertPr({ status: 'closed' });
            await insertPr({ merged: true });
            await insertPr({ repository: { id: 'repo-out', name: 'x' } });
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
            await insertPr({ organizationId: OTHER_ORG });
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

        it('counts open pull requests that still carry an unresolved delivered suggestion', async () => {
            await expect(count()).resolves.toBe(4);
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
    },
);
