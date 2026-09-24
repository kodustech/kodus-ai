/**
 * INTEGRATION TEST - Tests the exact flow we changed in SavePullRequestUseCase:
 *
 * BEFORE: Every webhook event called the Git API to fetch files/commits
 * AFTER:  Only "opened"/"synchronize" fetch from API. Other events use DB cache.
 *
 * This test uses:
 * - REAL MongoDB + PullRequestsRepository (to test the DB cache path)
 * - MOCK CodeManagementService (to verify it's NOT called for cached events)
 * - MOCK PullRequestsService (to spy on what files/commits are passed)
 * - MOCK IntegrationConfigService (to return org/team data)
 *
 * Requires a running MongoDB instance.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigModule } from '@nestjs/config';

import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PULL_REQUESTS_REPOSITORY_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import { resolveMongoTestGate } from '../mongo-test-uri';

const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test');

(shouldSkip ? describe.skip : describe)(
    'SavePullRequestUseCase - Full flow integration (DB cache vs API)',
    () => {
        let useCase: SavePullRequestUseCase;
        let model: Model<PullRequestsModel>;
        let module: TestingModule;

        let mockCodeManagementService: any;
        let mockPullRequestsService: any;
        let mockIntegrationConfigService: any;

        const TEST_ORG_ID = 'test-org-flow-' + Date.now();
        const TEST_TEAM_ID = 'test-team-flow-' + Date.now();

        // Files that the Git API would return
        const API_FILES = [
            { filename: 'src/api-file.ts', additions: 99, deletions: 99 },
        ];

        // Commits that the Git API would return
        const API_COMMITS = [{ sha: 'api-commit-sha', message: 'from api' }];

        // Files already saved in the DB (REAL IFile format from MongoDB)
        const DB_FILES = [
            {
                path: 'src/cached-file.ts',
                filename: 'cached-file.ts',
                previousName: '',
                status: 'modified',
                added: 10,
                deleted: 5,
                changes: 15,
                patch: '@@ cached',
                sha: 'file-sha-1',
                suggestions: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                path: 'src/cached-file2.ts',
                filename: 'cached-file2.ts',
                previousName: '',
                status: 'added',
                added: 20,
                deleted: 0,
                changes: 20,
                patch: '@@ cached2',
                sha: 'file-sha-2',
                suggestions: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ];

        // Commits already saved in the DB
        const DB_COMMITS = [
            { sha: 'db-commit-1', message: 'cached commit 1' },
            { sha: 'db-commit-2', message: 'cached commit 2' },
        ];

        // GitHub webhook payload structure
        const makeGitHubPayload = (action: string) => ({
            action,
            pull_request: {
                number: 42,
                title: 'Test PR',
                user: { id: 'user-1', login: 'testuser' },
                head: { ref: 'feature-branch', sha: 'abc123' },
                base: { ref: 'main' },
            },
            repository: {
                id: 'repo-flow-test',
                name: 'test-repo',
                full_name: 'org/test-repo',
            },
            sender: { id: 'user-1', login: 'testuser' },
        });

        beforeAll(async () => {
            mockCodeManagementService = {
                getFilesByPullRequestId: jest.fn().mockResolvedValue(API_FILES),
                getCommitsForPullRequestForCodeReview: jest
                    .fn()
                    .mockResolvedValue(API_COMMITS),
            };

            mockPullRequestsService = {
                aggregateAndSaveDataStructure: jest
                    .fn()
                    .mockResolvedValue(null),
            };

            mockIntegrationConfigService = {
                findIntegrationConfigWithTeams: jest.fn().mockResolvedValue([
                    {
                        team: {
                            uuid: TEST_TEAM_ID,
                            organization: { uuid: TEST_ORG_ID },
                        },
                    },
                ]),
            };

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
                providers: [
                    SavePullRequestUseCase,
                    {
                        provide: PULL_REQUESTS_REPOSITORY_TOKEN,
                        useClass: PullRequestsRepository, // REAL repository → REAL MongoDB
                    },
                    {
                        provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                        useValue: mockIntegrationConfigService,
                    },
                    {
                        provide: PULL_REQUESTS_SERVICE_TOKEN,
                        useValue: mockPullRequestsService,
                    },
                    {
                        provide: CodeManagementService,
                        useValue: mockCodeManagementService,
                    },
                ],
            }).compile();

            useCase = module.get<SavePullRequestUseCase>(
                SavePullRequestUseCase,
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
            jest.clearAllMocks();
            await model.deleteMany({ organizationId: TEST_ORG_ID });
        });

        /**
         * Inserts a PR into MongoDB simulating what a previous "opened" event would have saved.
         */
        async function insertPRInDB() {
            await model.create({
                organizationId: TEST_ORG_ID,
                number: 42,
                title: 'Test PR',
                status: 'open',
                merged: false,
                url: 'https://github.com/org/test-repo/pull/42',
                baseBranchRef: 'main',
                headBranchRef: 'feature-branch',
                repository: {
                    id: 'repo-flow-test',
                    name: 'test-repo',
                    fullName: 'org/test-repo',
                    language: 'TypeScript',
                    url: 'https://github.com/org/test-repo',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                openedAt: new Date().toISOString(),
                closedAt: '',
                files: DB_FILES,
                commits: DB_COMMITS,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                provider: 'github',
                user: { id: 'user-1', username: 'testuser' },
                isDraft: false,
            });
        }

        describe('action: "opened" → must fetch from Git API', () => {
            it('should call CodeManagementService and pass API data to aggregateAndSaveDataStructure', async () => {
                await useCase.execute({
                    payload: makeGitHubPayload('opened'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                });

                // MUST call Git API
                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalledTimes(1);
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalledTimes(1);

                // aggregateAndSaveDataStructure receives API data
                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2]; // 3rd param = changedFiles
                const commitsArg = callArgs[7]; // 8th param = pullRequestCommits

                expect(filesArg).toEqual(API_FILES);
                expect(commitsArg).toEqual(API_COMMITS);
            });
        });

        describe('action: "synchronize" → must fetch from Git API', () => {
            it('should call CodeManagementService even if PR exists in DB', async () => {
                await insertPRInDB(); // PR exists in DB, but should be ignored

                await useCase.execute({
                    payload: makeGitHubPayload('synchronize'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                });

                // MUST call Git API (new commits pushed)
                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalledTimes(1);
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalledTimes(1);

                // aggregateAndSaveDataStructure receives API data, NOT DB data
                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                expect(filesArg).toEqual(API_FILES);
                expect(commitsArg).toEqual(API_COMMITS);
            });
        });

        describe('action: "closed" → must use DB cache', () => {
            it('should NOT call CodeManagementService and pass DB data to aggregateAndSaveDataStructure', async () => {
                await insertPRInDB();

                await useCase.execute({
                    payload: makeGitHubPayload('closed'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                });

                // MUST NOT call Git API
                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();

                // aggregateAndSaveDataStructure receives data FROM THE DATABASE
                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                // Files from DB, mapped to API format
                expect(filesArg).toHaveLength(2);
                // 'filename' must be full path (from DB 'path')
                expect(filesArg[0].filename).toBe('src/cached-file.ts');
                expect(filesArg[1].filename).toBe('src/cached-file2.ts');
                // 'additions'/'deletions' must be mapped from DB 'added'/'deleted'
                expect(filesArg[0].additions).toBe(10);
                expect(filesArg[0].deletions).toBe(5);
                expect(filesArg[1].additions).toBe(20);
                expect(filesArg[1].deletions).toBe(0);
                // 'patch' must be preserved (stored via MongoDB Mixed type)
                expect(filesArg[0].patch).toBe('@@ cached');
                expect(filesArg[1].patch).toBe('@@ cached2');

                // Commits from DB
                expect(commitsArg).toHaveLength(2);
                expect(commitsArg[0].sha).toBe('db-commit-1');
                expect(commitsArg[1].sha).toBe('db-commit-2');
            });

            it('should pass empty arrays when PR does not exist in DB', async () => {
                // NO PR in DB

                await useCase.execute({
                    payload: makeGitHubPayload('closed'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                });

                // MUST NOT call Git API
                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();

                // aggregateAndSaveDataStructure receives empty arrays
                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                expect(filesArg).toEqual([]);
                expect(commitsArg).toEqual([]);
            });
        });

        describe('action: "assigned" → must use DB cache', () => {
            it('should NOT call CodeManagementService and pass DB data', async () => {
                await insertPRInDB();

                await useCase.execute({
                    payload: makeGitHubPayload('assigned'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                });

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();

                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                expect(filesArg).toHaveLength(2);
                expect(commitsArg).toHaveLength(2);
            });
        });

        describe('action: "ready_for_review" → must fetch from Git API', () => {
            it('should call CodeManagementService even if PR exists in DB', async () => {
                await insertPRInDB();

                await useCase.execute({
                    payload: makeGitHubPayload('ready_for_review'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                });

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalledTimes(1);
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalledTimes(1);

                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                expect(callArgs[2]).toEqual(API_FILES);
                expect(callArgs[7]).toEqual(API_COMMITS);
            });
        });
    },
);
