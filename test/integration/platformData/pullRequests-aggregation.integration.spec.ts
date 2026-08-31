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
import { resolveMongoTestGate } from '../mongo-test-uri';

/**
 * In-memory counting function (the OLD way)
 * This is the exact logic from GetEnrichedPullRequestsUseCase
 *
 * It only tracks sent/filtered — the pair this suite exists to keep in sync.
 * The aggregation has since grown richer (failed/replaced/unresolved,
 * bySeverity, categories, firstSentSuggestion), so aggregation results are
 * asserted with toMatchObject against this reference: toEqual would fail on
 * the extra keys and say nothing about the sent/filtered parity under test.
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

// Skipped locally without Mongo; a CI run without it fails loudly
// instead — see resolveMongoTestGate.
const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test');

(shouldSkip ? describe.skip : describe)(
    'PullRequests Aggregation vs In-Memory Counting',
    () => {
        let repository: PullRequestsRepository;
        let model: Model<PullRequestsModel>;
        let module: TestingModule;

        const TEST_ORG_ID = 'test-org-aggregation-' + Date.now();

        beforeAll(async () => {
            // Build connection string


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
                suggestions: Array<{
                    deliveryStatus: DeliveryStatus;
                    // Optional overrides so a case can exercise the deep-link
                    // ranking (unresolved first, then severity).
                    severity?: string;
                    implementationStatus?: string;
                }>;
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
                        // Case-specific overrides win over the defaults above.
                        ...s,
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
                expect(aggregationCounts).toMatchObject(inMemoryResult);

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
                expect(aggregationCounts).toMatchObject({ sent: 0, filtered: 0 });
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

                expect(aggregationResult.get('repo-1_3')).toMatchObject(
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

                expect(aggregationResult.get('repo-1_4')).toMatchObject(
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
                expect(aggregationResult.get('repo-A_10')).toMatchObject(
                    extractSuggestionsCountInMemory(pr1),
                );
                expect(aggregationResult.get('repo-A_20')).toMatchObject(
                    extractSuggestionsCountInMemory(pr2),
                );
                expect(aggregationResult.get('repo-B_30')).toMatchObject(
                    extractSuggestionsCountInMemory(pr3),
                );

                // Verify actual values
                expect(aggregationResult.get('repo-A_10')).toMatchObject({
                    sent: 1,
                    filtered: 1,
                });
                expect(aggregationResult.get('repo-A_20')).toMatchObject({
                    sent: 3,
                    filtered: 0,
                });
                expect(aggregationResult.get('repo-B_30')).toMatchObject({
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

                expect(aggregationResult.get('repo-large_100')).toMatchObject(
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

                expect(result.get('repo-empty_999')).toMatchObject({
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

        describe('Deep-link target (firstSentSuggestion)', () => {
            it('should expose the first DELIVERED suggestion with its file path', async () => {
                await createTestPR({
                    number: 601,
                    repositoryId: 'repo-deeplink',
                    files: [
                        {
                            // First file: NOT_SENT first, then SENT — the deep
                            // link must point at the earliest sent finding
                            // (sugg-0-1), not the one in the second file.
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.NOT_SENT },
                                { deliveryStatus: DeliveryStatus.SENT },
                                { deliveryStatus: DeliveryStatus.SENT },
                            ],
                        },
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.SENT },
                            ],
                        },
                    ],
                });

                const result =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 601, repositoryId: 'repo-deeplink' }],
                        TEST_ORG_ID,
                    );

                const counts = result.get('repo-deeplink_601');
                expect(counts?.firstSentSuggestion).toEqual({
                    id: 'sugg-0-1',
                    filePath: 'src/file0.ts',
                });
            });

            it('should prefer an unresolved critical over a low that comes first', async () => {
                await createTestPR({
                    number: 603,
                    repositoryId: 'repo-deeplink',
                    files: [
                        {
                            suggestions: [
                                {
                                    deliveryStatus: DeliveryStatus.SENT,
                                    severity: 'low',
                                },
                            ],
                        },
                        {
                            suggestions: [
                                {
                                    deliveryStatus: DeliveryStatus.SENT,
                                    severity: 'critical',
                                },
                            ],
                        },
                    ],
                });

                const result =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 603, repositoryId: 'repo-deeplink' }],
                        TEST_ORG_ID,
                    );

                expect(
                    result.get('repo-deeplink_603')?.firstSentSuggestion,
                ).toEqual({ id: 'sugg-1-0', filePath: 'src/file1.ts' });
            });

            it('should prefer any open finding over an applied one, however severe', async () => {
                await createTestPR({
                    number: 604,
                    repositoryId: 'repo-deeplink',
                    files: [
                        {
                            suggestions: [
                                {
                                    deliveryStatus: DeliveryStatus.SENT,
                                    severity: 'critical',
                                    implementationStatus: 'implemented',
                                },
                                {
                                    deliveryStatus: DeliveryStatus.SENT,
                                    severity: 'low',
                                },
                            ],
                        },
                    ],
                });

                const result =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 604, repositoryId: 'repo-deeplink' }],
                        TEST_ORG_ID,
                    );

                expect(
                    result.get('repo-deeplink_604')?.firstSentSuggestion?.id,
                ).toBe('sugg-0-1');
            });

            it('should not leak the internal rank past the repository boundary', async () => {
                await createTestPR({
                    number: 605,
                    repositoryId: 'repo-deeplink',
                    files: [
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.SENT },
                            ],
                        },
                    ],
                });

                const result =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 605, repositoryId: 'repo-deeplink' }],
                        TEST_ORG_ID,
                    );

                expect(
                    Object.keys(
                        result.get('repo-deeplink_605')!.firstSentSuggestion!,
                    ).sort(),
                ).toEqual(['filePath', 'id']);
            });

            it('should be null when there is no delivered suggestion', async () => {
                await createTestPR({
                    number: 602,
                    repositoryId: 'repo-deeplink',
                    files: [
                        {
                            suggestions: [
                                { deliveryStatus: DeliveryStatus.NOT_SENT },
                                { deliveryStatus: DeliveryStatus.FAILED },
                            ],
                        },
                    ],
                });

                const result =
                    await repository.findSuggestionCountsByNumbersAndRepositoryIds(
                        [{ number: 602, repositoryId: 'repo-deeplink' }],
                        TEST_ORG_ID,
                    );

                const counts = result.get('repo-deeplink_602');
                expect(counts?.firstSentSuggestion).toBeNull();
            });
        });
    },
);
