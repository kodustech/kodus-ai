/**
 * INTEGRATION TEST - Simulates the FULL webhook flow:
 *
 *   Webhook payload → GitHubPullRequestHandler.execute() → SavePullRequestUseCase → MongoDB
 *
 * Tests that when a real GitHub webhook arrives:
 * - "opened" → handler calls savePullRequestUseCase → use case fetches from Git API
 * - "closed" → handler calls savePullRequestUseCase → use case uses DB cache (NOT the API)
 * - "synchronize" → handler calls savePullRequestUseCase → use case fetches from Git API
 *
 * REAL: GitHubPullRequestHandler, SavePullRequestUseCase, PullRequestsRepository, MongoDB
 * MOCK: RunCodeReviewAutomationUseCase, CodeManagementService, PullRequestsService, etc.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigModule } from '@nestjs/config';

import { OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';
import { GitHubPullRequestHandler } from '@libs/platform/infrastructure/webhooks/github/githubPullRequest.handler';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { RunCodeReviewAutomationUseCase } from '@libs/ee/automation/runCodeReview.use-case';
import { ChatWithKodyFromGitUseCase } from '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case';
import { GenerateIssuesFromPrClosedUseCase } from '@libs/issues/application/use-cases/generate-issues-from-pr-closed.use-case';
import { EnqueueCodeReviewJobUseCase } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { EventEmitter2 } from '@nestjs/event-emitter';
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

// Only use TEST_MONGODB_URI (not API_MG_DB_HOST which may be a Docker hostname
// loaded by dotenv/config via transitive imports like crypto.ts)
const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test', false);

(shouldSkip ? describe.skip : describe)(
    'GitHub Webhook → Handler → SavePullRequestUseCase → MongoDB (full flow)',
    () => {
        let handler: GitHubPullRequestHandler;
        let model: Model<PullRequestsModel>;
        let module: TestingModule;

        let mockCodeManagementService: any;
        let mockPullRequestsService: any;
        let mockRunCodeReviewAutomation: any;

        const TEST_ORG_ID = 'test-org-webhook-' + Date.now();
        const TEST_TEAM_ID = 'test-team-webhook-' + Date.now();

        // Data the Git API would return
        const API_FILES = [
            { filename: 'src/from-api.ts', additions: 99, deletions: 99 },
        ];
        const API_COMMITS = [
            { sha: 'api-sha-111', message: 'commit from api' },
        ];

        // Data already in MongoDB (saved by a previous "opened" event)
        // IMPORTANT: This is the REAL DB format (IFile), NOT the API format
        // DB uses: path (full), filename (short), added, deleted, previousName
        // API uses: filename (full), additions, deletions, previous_filename
        const DB_FILES = [
            {
                path: 'src/from-db.ts',
                filename: 'from-db.ts',
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
                path: 'src/from-db-2.ts',
                filename: 'from-db-2.ts',
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
        const DB_COMMITS = [
            { sha: 'db-sha-aaa', message: 'cached commit 1' },
            { sha: 'db-sha-bbb', message: 'cached commit 2' },
        ];

        /**
         * Simulates a real GitHub webhook payload.
         * This is the exact structure GitHub sends via HTTP POST.
         */
        const makeGitHubWebhookPayload = (action: string) => ({
            action,
            pull_request: {
                number: 42,
                title: 'feat: add new feature',
                html_url: 'https://github.com/org/test-repo/pull/42',
                user: { id: 100, login: 'developer' },
                head: {
                    ref: 'feature-branch',
                    sha: 'head-sha-123',
                    repo: { full_name: 'org/test-repo' },
                },
                base: {
                    ref: 'main',
                    sha: 'base-sha-456',
                    repo: {
                        full_name: 'org/test-repo',
                        default_branch: 'main',
                    },
                },
                merged: action === 'closed', // simulate merged on close
                draft: false,
                labels: [],
                body: 'PR description',
            },
            repository: {
                id: 12345,
                name: 'test-repo',
                full_name: 'org/test-repo',
            },
            sender: { id: 100, login: 'developer' },
        });

        beforeAll(async () => {
            mockCodeManagementService = {
                getFilesByPullRequestId: jest.fn().mockResolvedValue(API_FILES),
                getCommitsForPullRequestForCodeReview: jest
                    .fn()
                    .mockResolvedValue(API_COMMITS),
                getDefaultBranch: jest.fn().mockResolvedValue('main'),
                getPullRequest: jest.fn().mockResolvedValue(null),
            };

            mockPullRequestsService = {
                aggregateAndSaveDataStructure: jest
                    .fn()
                    .mockResolvedValue(null),
            };

            mockRunCodeReviewAutomation = {
                findTeamWithActiveCodeReview: jest.fn().mockResolvedValue({
                    organizationAndTeamData: {
                        organizationId: TEST_ORG_ID,
                        teamId: TEST_TEAM_ID,
                    },
                }),
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
                    // REAL handler + use case + repository
                    GitHubPullRequestHandler,
                    SavePullRequestUseCase,
                    {
                        provide: PULL_REQUESTS_REPOSITORY_TOKEN,
                        useClass: PullRequestsRepository,
                    },
                    // MOCK everything else
                    // The handler resolves org/team through
                    // WebhookContextService (it used to reach for the
                    // integration-config service directly) — without this
                    // provider Nest can't build the handler at all.
                    {
                        provide: WebhookContextService,
                        useValue: {
                            getContext: jest.fn().mockResolvedValue({
                                organizationAndTeamData: {
                                    organizationId: TEST_ORG_ID,
                                    teamId: TEST_TEAM_ID,
                                },
                                teamAutomationId: 'test-team-automation',
                            }),
                        },
                    },
                    {
                        provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                        useValue: {
                            findIntegrationConfigWithTeams: jest
                                .fn()
                                .mockResolvedValue([
                                    {
                                        team: {
                                            uuid: TEST_TEAM_ID,
                                            organization: { uuid: TEST_ORG_ID },
                                        },
                                    },
                                ]),
                        },
                    },
                    {
                        provide: PULL_REQUESTS_SERVICE_TOKEN,
                        useValue: mockPullRequestsService,
                    },
                    {
                        provide: CodeManagementService,
                        useValue: mockCodeManagementService,
                    },
                    {
                        provide: RunCodeReviewAutomationUseCase,
                        useValue: mockRunCodeReviewAutomation,
                    },
                    {
                        provide: ChatWithKodyFromGitUseCase,
                        useValue: { execute: jest.fn() },
                    },
                    {
                        provide: GenerateIssuesFromPrClosedUseCase,
                        useValue: { execute: jest.fn() },
                    },
                    {
                        provide: EventEmitter2,
                        useValue: { emit: jest.fn() },
                    },
                    {
                        provide: EnqueueCodeReviewJobUseCase,
                        useValue: {
                            execute: jest.fn().mockResolvedValue('job-123'),
                        },
                    },
                    {
                        provide: EnqueueImplementationCheckUseCase,
                        useValue: {
                            execute: jest.fn().mockResolvedValue(null),
                        },
                    },
                    {
                        provide: OUTBOX_MESSAGE_REPOSITORY_TOKEN,
                        // create() is awaited via .catch() on the PR-closed
                        // path, so the mock has to return a promise.
                        useValue: {
                            create: jest.fn().mockResolvedValue(undefined),
                        },
                    },
                ],
            }).compile();

            handler = module.get<GitHubPullRequestHandler>(
                GitHubPullRequestHandler,
            );
            model = module.get<Model<PullRequestsModel>>(
                getModelToken(PullRequestsModel.name),
            );
        });

        afterAll(async () => {
            if (model) await model.deleteMany({ organizationId: TEST_ORG_ID });
            if (module) await module.close();
        });

        beforeEach(async () => {
            jest.clearAllMocks();
            await model.deleteMany({ organizationId: TEST_ORG_ID });
        });

        /**
         * Inserts a PR in MongoDB (simulates what a previous "opened" webhook would have saved)
         */
        async function insertPRInDB() {
            await model.create({
                organizationId: TEST_ORG_ID,
                number: 42,
                title: 'feat: add new feature',
                status: 'open',
                merged: false,
                url: 'https://github.com/org/test-repo/pull/42',
                baseBranchRef: 'main',
                headBranchRef: 'feature-branch',
                repository: {
                    id: '12345',
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
                user: { id: '100', username: 'developer' },
                isDraft: false,
            });
        }

        describe('Webhook "opened" → fetches from Git API', () => {
            it('should call Git API and pass API data through the whole flow', async () => {
                const webhookParams = {
                    payload: makeGitHubWebhookPayload('opened'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                // Simulate webhook arriving at handler
                await handler.execute(webhookParams);

                // Git API MUST be called
                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalledTimes(1);
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalledTimes(1);

                // aggregateAndSaveDataStructure receives data FROM THE API
                expect(
                    mockPullRequestsService.aggregateAndSaveDataStructure,
                ).toHaveBeenCalledTimes(1);
                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                expect(filesArg).toEqual(API_FILES);
                expect(commitsArg).toEqual(API_COMMITS);
            });
        });

        describe('Webhook "closed" with PR in DB → uses cache', () => {
            it('should NOT call Git API and pass DB data through the whole flow', async () => {
                // PR exists in MongoDB from a previous "opened" event
                await insertPRInDB();

                const webhookParams = {
                    payload: makeGitHubWebhookPayload('closed'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                // Simulate webhook arriving at handler
                await handler.execute(webhookParams);

                // Git API must NOT be called by SavePullRequestUseCase
                // Note: the handler itself may call getFilesByPullRequestId for Kody Rules sync on merge,
                // but SavePullRequestUseCase should not call it for the "closed" action
                expect(
                    mockPullRequestsService.aggregateAndSaveDataStructure,
                ).toHaveBeenCalledTimes(1);

                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                // Data must come FROM THE DATABASE, mapped to API format
                expect(filesArg).toHaveLength(2);

                // 'filename' must be the FULL PATH (from DB 'path'), not the short name
                expect(filesArg[0].filename).toBe('src/from-db.ts');
                expect(filesArg[1].filename).toBe('src/from-db-2.ts');

                // 'additions'/'deletions' must be mapped from DB 'added'/'deleted'
                expect(filesArg[0].additions).toBe(10);
                expect(filesArg[0].deletions).toBe(5);
                expect(filesArg[1].additions).toBe(20);
                expect(filesArg[1].deletions).toBe(0);

                // Other fields must be preserved (including patch from MongoDB Mixed type)
                expect(filesArg[0].patch).toBe('@@ cached');
                expect(filesArg[0].sha).toBe('file-sha-1');
                expect(filesArg[0].status).toBe('modified');

                expect(commitsArg).toHaveLength(2);
                expect(commitsArg[0].sha).toBe('db-sha-aaa');
                expect(commitsArg[1].sha).toBe('db-sha-bbb');
            });
        });

        describe('Webhook "closed" without PR in DB → empty arrays', () => {
            it('should NOT call Git API and pass empty arrays', async () => {
                // NO PR in database

                const webhookParams = {
                    payload: makeGitHubWebhookPayload('closed'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await handler.execute(webhookParams);

                expect(
                    mockPullRequestsService.aggregateAndSaveDataStructure,
                ).toHaveBeenCalledTimes(1);
                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                expect(filesArg).toEqual([]);
                expect(commitsArg).toEqual([]);
            });
        });

        describe('Webhook "synchronize" with PR in DB → still fetches from API', () => {
            it('should call Git API because new commits were pushed (ignores cache)', async () => {
                // Even though PR exists in DB, synchronize = new push = must fetch fresh data
                await insertPRInDB();

                const webhookParams = {
                    payload: makeGitHubWebhookPayload('synchronize'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await handler.execute(webhookParams);

                // Git API MUST be called
                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();

                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                // Data from API, NOT from DB
                expect(filesArg).toEqual(API_FILES);
                expect(commitsArg).toEqual(API_COMMITS);
            });
        });

        describe('Webhook "ready_for_review" → fetches from API', () => {
            it('should call Git API when draft becomes ready', async () => {
                await insertPRInDB();

                const webhookParams = {
                    payload: makeGitHubWebhookPayload('ready_for_review'),
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await handler.execute(webhookParams);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();

                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                expect(callArgs[2]).toEqual(API_FILES);
                expect(callArgs[7]).toEqual(API_COMMITS);
            });
        });
    },
);
