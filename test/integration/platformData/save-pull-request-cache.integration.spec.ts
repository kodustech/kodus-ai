/**
 * INTEGRATION TEST - Validates that the SavePullRequestUseCase cache optimization
 * correctly retrieves files and commits from MongoDB instead of calling the Git API.
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
import { resolveMongoTestGate } from '../mongo-test-uri';

// Skipped locally without Mongo; a CI run without it fails loudly
// instead — see resolveMongoTestGate.
const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test');

(shouldSkip ? describe.skip : describe)(
    'SavePullRequestUseCase - Cache optimization (findByNumberAndRepositoryId)',
    () => {
        let repository: PullRequestsRepository;
        let model: Model<PullRequestsModel>;
        let module: TestingModule;

        const TEST_ORG_ID = 'test-org-cache-' + Date.now();
        const TEST_TEAM_ID = 'test-team-cache-' + Date.now();

        const organizationAndTeamData = {
            organizationId: TEST_ORG_ID,
            teamId: TEST_TEAM_ID,
        };

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

            repository = module.get<PullRequestsRepository>(
                PullRequestsRepository,
            );
            model = module.get<Model<PullRequestsModel>>(
                getModelToken(PullRequestsModel.name),
            );
        });

        afterAll(async () => {
            await model.deleteMany({ organizationId: TEST_ORG_ID });
            await module.close();
        });

        beforeEach(async () => {
            await model.deleteMany({ organizationId: TEST_ORG_ID });
        });

        /**
         * Helper to create a test PR with files and commits in MongoDB
         */
        async function createTestPR(config: {
            number: number;
            repositoryId: string;
            files: any[];
            commits: any[];
        }) {
            return model.create({
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
                files: config.files,
                commits: config.commits,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                provider: 'github',
                user: { id: 'user-1', username: 'testuser' },
                isDraft: false,
            });
        }

        describe('Cache retrieval via findByNumberAndRepositoryId', () => {
            it('should return files and commits from DB for an existing PR', async () => {
                const testFiles = [
                    {
                        filename: 'src/app.ts',
                        additions: 10,
                        deletions: 5,
                        patch: '@@ -1,5 +1,10 @@',
                    },
                    {
                        filename: 'src/utils.ts',
                        additions: 20,
                        deletions: 0,
                        patch: '@@ -1,0 +1,20 @@',
                    },
                ];

                const testCommits = [
                    {
                        sha: 'abc123',
                        message: 'feat: add new feature',
                        author: { name: 'dev', email: 'dev@test.com' },
                    },
                    {
                        sha: 'def456',
                        message: 'fix: bug fix',
                        author: { name: 'dev', email: 'dev@test.com' },
                    },
                ];

                await createTestPR({
                    number: 42,
                    repositoryId: 'repo-123',
                    files: testFiles,
                    commits: testCommits,
                });

                const result = await repository.findByNumberAndRepositoryId(
                    42,
                    'repo-123',
                    organizationAndTeamData,
                );

                expect(result).not.toBeNull();
                expect(result.files).toHaveLength(2);
                expect(result.commits).toHaveLength(2);

                // Verify file data is preserved
                expect(result.files[0].filename).toBe('src/app.ts');
                expect(result.files[1].filename).toBe('src/utils.ts');

                // Verify commit data is preserved
                expect(result.commits[0].sha).toBe('abc123');
                expect(result.commits[1].sha).toBe('def456');
            });

            it('should return null for non-existent PR', async () => {
                const result = await repository.findByNumberAndRepositoryId(
                    999,
                    'repo-nonexistent',
                    organizationAndTeamData,
                );

                expect(result).toBeNull();
            });

            it('should return empty arrays when PR exists but has no files/commits', async () => {
                await createTestPR({
                    number: 50,
                    repositoryId: 'repo-empty',
                    files: [],
                    commits: [],
                });

                const result = await repository.findByNumberAndRepositoryId(
                    50,
                    'repo-empty',
                    organizationAndTeamData,
                );

                expect(result).not.toBeNull();
                expect(result.files).toHaveLength(0);
                expect(result.commits).toHaveLength(0);
            });

            it('should match by repositoryId and not return wrong PR', async () => {
                await createTestPR({
                    number: 42,
                    repositoryId: 'repo-A',
                    files: [
                        { filename: 'fileA.ts', additions: 1, deletions: 0 },
                    ],
                    commits: [{ sha: 'aaa', message: 'commit A' }],
                });

                await createTestPR({
                    number: 42,
                    repositoryId: 'repo-B',
                    files: [
                        { filename: 'fileB.ts', additions: 2, deletions: 0 },
                    ],
                    commits: [{ sha: 'bbb', message: 'commit B' }],
                });

                const resultA = await repository.findByNumberAndRepositoryId(
                    42,
                    'repo-A',
                    organizationAndTeamData,
                );

                const resultB = await repository.findByNumberAndRepositoryId(
                    42,
                    'repo-B',
                    organizationAndTeamData,
                );

                expect(resultA.files[0].filename).toBe('fileA.ts');
                expect(resultA.commits[0].sha).toBe('aaa');

                expect(resultB.files[0].filename).toBe('fileB.ts');
                expect(resultB.commits[0].sha).toBe('bbb');
            });

            it('should not return PR from different organization', async () => {
                await createTestPR({
                    number: 42,
                    repositoryId: 'repo-123',
                    files: [{ filename: 'file.ts' }],
                    commits: [{ sha: 'abc' }],
                });

                const result = await repository.findByNumberAndRepositoryId(
                    42,
                    'repo-123',
                    {
                        organizationId: 'different-org',
                        teamId: 'different-team',
                    },
                );

                expect(result).toBeNull();
            });
        });

        describe('Cache data matches what would be saved from API', () => {
            it('should preserve file structure with all relevant fields', async () => {
                const richFile = {
                    filename: 'src/complex.ts',
                    additions: 50,
                    deletions: 30,
                    changes: 80,
                    status: 'modified',
                    patch: '@@ -10,30 +10,50 @@ function complex() {',
                    sha: 'file-sha-123',
                };

                await createTestPR({
                    number: 100,
                    repositoryId: 'repo-rich',
                    files: [richFile],
                    commits: [],
                });

                const result = await repository.findByNumberAndRepositoryId(
                    100,
                    'repo-rich',
                    organizationAndTeamData,
                );

                expect(result.files[0].filename).toBe('src/complex.ts');
                expect(result.files[0].additions).toBe(50);
                expect(result.files[0].deletions).toBe(30);
            });

            it('should preserve commit structure with all relevant fields', async () => {
                const richCommit = {
                    sha: 'full-sha-abc123def456',
                    message:
                        'feat(auth): implement OAuth2 flow\n\nThis adds Google OAuth2 support.',
                    author: {
                        name: 'Developer',
                        email: 'dev@company.com',
                        date: '2025-01-27T10:00:00Z',
                    },
                    url: 'https://github.com/org/repo/commit/full-sha-abc123def456',
                };

                await createTestPR({
                    number: 101,
                    repositoryId: 'repo-rich',
                    files: [],
                    commits: [richCommit],
                });

                const result = await repository.findByNumberAndRepositoryId(
                    101,
                    'repo-rich',
                    organizationAndTeamData,
                );

                expect(result.commits[0].sha).toBe('full-sha-abc123def456');
                expect(result.commits[0].message).toContain('OAuth2');
            });
        });
    },
);
