/**
 * INTEGRATION TEST - Validates that MongoDB aggregation returns
 * identical results to the in-memory counting method.
 *
 * This test requires a running MongoDB instance.
 * Run with: yarn test:integration or manually with Docker.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigModule } from '@nestjs/config';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { IPullRequests } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

/**
 * In-memory counting function (the OLD way)
 * This is the exact logic from GetEnrichedPullRequestsUseCase
 */
function extractSuggestionsCountInMemory(pullRequest: IPullRequests): {
    sent: number;
    filtered: number;
} {
    let sent = 0;
    let filtered = 0;

    const files = pullRequest.files;
    if (!files || files.length === 0) {
        return { sent: 0, filtered: 0 };
    }

    for (let i = 0; i < files.length; i++) {
        const suggestions = files[i].suggestions;
        if (!suggestions) continue;

        for (let j = 0; j < suggestions.length; j++) {
            const status = suggestions[j].deliveryStatus;
            if (status === DeliveryStatus.SENT) {
                sent++;
            } else if (status === DeliveryStatus.NOT_SENT) {
                filtered++;
            }
        }
    }

    return { sent, filtered };
}

// Skip if no MongoDB connection available
const MONGODB_URI = process.env.TEST_MONGODB_URI || process.env.API_MG_DB_HOST;
const shouldSkip = !MONGODB_URI;

(shouldSkip ? describe.skip : describe)(
    'PullRequests Aggregation vs In-Memory Counting',
    () => {
        let repository: PullRequestsRepository;
        let model: Model<PullRequestsModel>;
        let module: TestingModule;

        const TEST_ORG_ID = 'test-org-aggregation-' + Date.now();

        beforeAll(async () => {
            // Build connection string
            const mongoUri = MONGODB_URI?.includes('://')
                ? MONGODB_URI
                : `mongodb://${MONGODB_URI}:27017/kodus_test`;

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

            repository = module.get<PullRequestsRepository>(
                PullRequestsRepository,
            );
            model = module.get<Model<PullRequestsModel>>(
                getModelToken(PullRequestsModel.name),
            );
        });

        afterAll(async () => {
            // Cleanup test data
            await model.deleteMany({ organizationId: TEST_ORG_ID });
            await module.close();
        });

        beforeEach(async () => {
            // Clean before each test
            await model.deleteMany({ organizationId: TEST_ORG_ID });
        });

        /**
         * Helper to create a test PR with known suggestion counts
         */
        async function createTestPR(config: {
            number: number;
            repositoryId: string;
            files: Array<{
                suggestions: Array<{ deliveryStatus: DeliveryStatus }>;
            }>;
        }): Promise<IPullRequests> {
            const pr: Partial<IPullRequests> = {
                organizationId: TEST_ORG_ID,
                number: config.number,
                title: `Test PR #${config.number}`,
                status: 'open',
                merged: false,
                url: `https://github.com/test/repo/pull/${config.number}`,
                baseBranchRef: 'main',
                headBranchRef: 'feature/test',
                repository: {
                    id: config.repositoryId,
                    name: 'test-repo',
                    fullName: 'org/test-repo',
                    language: 'TypeScript',
                    url: 'https://github.com/org/test-repo',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                openedAt: new Date().toISOString(),
                closedAt: '',
                files: config.files.map((f, fileIdx) => ({
                    id: `file-${fileIdx}`,
                    path: `src/file${fileIdx}.ts`,
                    filename: `file${fileIdx}.ts`,
                    previousName: '',
                    status: 'modified',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    suggestions: f.suggestions.map((s, suggIdx) => ({
                        id: `sugg-${fileIdx}-${suggIdx}`,
                        relevantFile: `src/file${fileIdx}.ts`,
                        language: 'typescript',
                        suggestionContent: 'Test content',
                        existingCode: 'old code',
                        improvedCode: 'new code',
                        oneSentenceSummary: 'Test summary',
                        relevantLinesStart: 1,
                        relevantLinesEnd: 10,
                        label: 'code_style',
                        severity: 'low',
                        priorityStatus: PriorityStatus.PRIORITIZED,
                        deliveryStatus: s.deliveryStatus,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    })),
                })),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                provider: 'github',
                user: { id: 'user-1', username: 'testuser' },
                commits: [],
                isDraft: false,
            };

            const created = await model.create(pr as any);
            return created.toObject() as unknown as IPullRequests;
        }

        describe('CRITICAL: Aggregation must match in-memory counting', () => {
            it('should return identical results for PR with mixed statuses', async () => {
                // Create PR with known distribution
                const pr = await createTestPR({
                    number: 1,
                    repositoryId: 'repo-1',
                    files: [
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.SENT },
                                { deliveryStatus: DeliveryStatus.SENT },
                                { deliveryStatus: DeliveryStatus.NOT_SENT },
                                { deliveryStatus: DeliveryStatus.FAILED },
                            ],
                        },
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.NOT_SENT },
                                { deliveryStatus: DeliveryStatus.SENT },
                            ],
                        },
                    ],
                });

                // Get counts via AGGREGATION (new method)
                const aggregationResult =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 1, repositoryId: 'repo-1' }],
                        TEST_ORG_ID,
                    );

                // Get counts via IN-MEMORY (old method)
                const inMemoryResult = extractSuggestionsCountInMemory(pr);

                // They MUST be identical
                const aggregationCounts = aggregationResult.get('repo-1_1');

                expect(aggregationCounts).toBeDefined();
                expect(aggregationCounts).toEqual(inMemoryResult);

                // Verify the actual values
                expect(inMemoryResult).toEqual({ sent: 3, filtered: 2 });
            });

            it('should return identical results for PR with no suggestions', async () => {
                await createTestPR({
                    number: 2,
                    repositoryId: 'repo-1',
                    files: [{ suggestions: [] }],
                });

                const aggregationResult =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 2, repositoryId: 'repo-1' }],
                        TEST_ORG_ID,
                    );

                const aggregationCounts = aggregationResult.get('repo-1_2');

                // Both should be zero
                expect(aggregationCounts).toEqual({ sent: 0, filtered: 0 });
            });

            it('should return identical results for PR with only SENT', async () => {
                const pr = await createTestPR({
                    number: 3,
                    repositoryId: 'repo-1',
                    files: [
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.SENT },
                                { deliveryStatus: DeliveryStatus.SENT },
                                { deliveryStatus: DeliveryStatus.SENT },
                            ],
                        },
                    ],
                });

                const aggregationResult =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 3, repositoryId: 'repo-1' }],
                        TEST_ORG_ID,
                    );
                const inMemoryResult = extractSuggestionsCountInMemory(pr);

                expect(aggregationResult.get('repo-1_3')).toEqual(
                    inMemoryResult,
                );
                expect(inMemoryResult).toEqual({ sent: 3, filtered: 0 });
            });

            it('should return identical results for PR with only NOT_SENT', async () => {
                const pr = await createTestPR({
                    number: 4,
                    repositoryId: 'repo-1',
                    files: [
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.NOT_SENT },
                                { deliveryStatus: DeliveryStatus.NOT_SENT },
                            ],
                        },
                    ],
                });

                const aggregationResult =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 4, repositoryId: 'repo-1' }],
                        TEST_ORG_ID,
                    );
                const inMemoryResult = extractSuggestionsCountInMemory(pr);

                expect(aggregationResult.get('repo-1_4')).toEqual(
                    inMemoryResult,
                );
                expect(inMemoryResult).toEqual({ sent: 0, filtered: 2 });
            });

            it('should return identical results for multiple PRs in batch', async () => {
                // Create 3 PRs with different patterns
                const pr1 = await createTestPR({
                    number: 10,
                    repositoryId: 'repo-A',
                    files: [
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.SENT },
                                { deliveryStatus: DeliveryStatus.NOT_SENT },
                            ],
                        },
                    ],
                });

                const pr2 = await createTestPR({
                    number: 20,
                    repositoryId: 'repo-A',
                    files: [
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.SENT },
                                { deliveryStatus: DeliveryStatus.SENT },
                                { deliveryStatus: DeliveryStatus.SENT },
                            ],
                        },
                    ],
                });

                const pr3 = await createTestPR({
                    number: 30,
                    repositoryId: 'repo-B',
                    files: [
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.NOT_SENT },
                                { deliveryStatus: DeliveryStatus.FAILED },
                            ],
                        },
                    ],
                });

                // Batch query
                const aggregationResult =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [
                            { number: 10, repositoryId: 'repo-A' },
                            { number: 20, repositoryId: 'repo-A' },
                            { number: 30, repositoryId: 'repo-B' },
                        ],
                        TEST_ORG_ID,
                    );

                // Compare each
                expect(aggregationResult.get('repo-A_10')).toEqual(
                    extractSuggestionsCountInMemory(pr1),
                );
                expect(aggregationResult.get('repo-A_20')).toEqual(
                    extractSuggestionsCountInMemory(pr2),
                );
                expect(aggregationResult.get('repo-B_30')).toEqual(
                    extractSuggestionsCountInMemory(pr3),
                );

                // Verify actual values
                expect(aggregationResult.get('repo-A_10')).toEqual({
                    sent: 1,
                    filtered: 1,
                });
                expect(aggregationResult.get('repo-A_20')).toEqual({
                    sent: 3,
                    filtered: 0,
                });
                expect(aggregationResult.get('repo-B_30')).toEqual({
                    sent: 0,
                    filtered: 1,
                });
            });

            it('should handle large PR with many files and suggestions', async () => {
                // Simulate realistic scenario: 50 files, 20 suggestions each
                const files = Array.from({ length: 50 }, (_, _fileIdx) => ({
                    suggestions: Array.from({ length: 20 }, (_, suggIdx) => {
                        // Distribute: 50% SENT, 30% NOT_SENT, 20% FAILED
                        const idx = suggIdx % 10;
                        let status: DeliveryStatus;
                        if (idx < 5) status = DeliveryStatus.SENT;
                        else if (idx < 8) status = DeliveryStatus.NOT_SENT;
                        else status = DeliveryStatus.FAILED;
                        return { deliveryStatus: status };
                    }),
                }));

                const pr = await createTestPR({
                    number: 100,
                    repositoryId: 'repo-large',
                    files,
                });

                const aggregationResult =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 100, repositoryId: 'repo-large' }],
                        TEST_ORG_ID,
                    );
                const inMemoryResult = extractSuggestionsCountInMemory(pr);

                expect(aggregationResult.get('repo-large_100')).toEqual(
                    inMemoryResult,
                );

                // 50 files × 20 suggestions = 1000 total
                // 50% SENT = 500, 30% NOT_SENT = 300, 20% FAILED = 200
                expect(inMemoryResult).toEqual({ sent: 500, filtered: 300 });
            });
        });

        describe('Edge cases', () => {
            it('should handle PR with no files', async () => {
                await model.create({
                    organizationId: TEST_ORG_ID,
                    number: 999,
                    title: 'Empty PR',
                    status: 'open',
                    merged: false,
                    url: 'https://github.com/test/repo/pull/999',
                    baseBranchRef: 'main',
                    headBranchRef: 'feature/test',
                    repository: {
                        id: 'repo-empty',
                        name: 'test-repo',
                        fullName: 'org/test-repo',
                        language: 'TypeScript',
                        url: 'https://github.com/org/test-repo',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                    openedAt: new Date().toISOString(),
                    closedAt: '',
                    files: [], // No files!
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    provider: 'github',
                    user: { id: 'user-1', username: 'testuser' },
                    commits: [],
                    isDraft: false,
                } as any);

                const result =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 999, repositoryId: 'repo-empty' }],
                        TEST_ORG_ID,
                    );

                expect(result.get('repo-empty_999')).toEqual({
                    sent: 0,
                    filtered: 0,
                });
            });

            it('should return empty map for non-existent PRs', async () => {
                const result =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 99999, repositoryId: 'non-existent' }],
                        TEST_ORG_ID,
                    );

                expect(result.size).toBe(0);
            });

            it('should return empty map for empty criteria', async () => {
                const result =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [],
                        TEST_ORG_ID,
                    );

                expect(result.size).toBe(0);
            });
        });
    },
);
