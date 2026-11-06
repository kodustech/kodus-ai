import {
    CheckConclusion,
    CheckStatus,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { Test, TestingModule } from '@nestjs/testing';
import { GithubChecksService } from './github-checks.service';
import { GithubService } from './github.service';

describe('GithubChecksService', () => {
    let service: GithubChecksService;
    let mockGithubService: jest.Mocked<GithubService>;
    let mockOctokit: any;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-1',
        installationId: 12345,
    } as any;

    const mockRepository = {
        owner: 'kodus-ai',
        name: 'kodus',
    } as any;

    beforeEach(async () => {
        mockOctokit = {
            checks: {
                create: jest.fn(),
                update: jest.fn(),
                listForRef: jest.fn(),
            },
            graphql: jest.fn(),
        };

        mockGithubService = {
            getGithubAuthDetails: jest
                .fn()
                .mockResolvedValue({ authMode: AuthMode.OAUTH }),
            getAuthenticatedOctokit: jest.fn().mockResolvedValue(mockOctokit),
            getGithubAppId: jest.fn().mockReturnValue(4242),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GithubChecksService,
                {
                    provide: GithubService,
                    useValue: mockGithubService,
                },
            ],
        }).compile();

        service = module.get<GithubChecksService>(GithubChecksService);
    });

    describe('findCheckRun', () => {
        const findParams = {
            organizationAndTeamData: mockOrganizationAndTeamData,
            repository: mockRepository,
            headSha: 'sha123',
            name: 'Kody Code Review',
        };

        it('should return the id of an in-progress check run (reusable)', async () => {
            mockOctokit.checks.listForRef.mockResolvedValue({
                data: {
                    check_runs: [{ id: 100, status: 'in_progress' }],
                },
            });

            const result = await service.findCheckRun(findParams);

            expect(mockOctokit.checks.listForRef).toHaveBeenCalledWith({
                owner: 'kodus-ai',
                repo: 'kodus',
                ref: 'sha123',
                check_name: 'Kody Code Review',
                filter: 'latest',
                per_page: 1,
            });
            expect(result).toBe(100);
        });

        it('should return null for a completed check run (cannot be reopened)', async () => {
            mockOctokit.checks.listForRef.mockResolvedValue({
                data: {
                    check_runs: [
                        { id: 100, status: 'completed', conclusion: 'failure' },
                    ],
                },
            });

            const result = await service.findCheckRun(findParams);

            expect(result).toBeNull();
        });

        it('should return null when no check run exists', async () => {
            mockOctokit.checks.listForRef.mockResolvedValue({
                data: { check_runs: [] },
            });

            const result = await service.findCheckRun(findParams);

            expect(result).toBeNull();
        });

        it('should return null on error', async () => {
            mockOctokit.checks.listForRef.mockRejectedValue(
                new Error('Failed'),
            );

            const result = await service.findCheckRun(findParams);

            expect(result).toBeNull();
        });
    });

    describe('createCheckRun', () => {
        it('should create a check run with status IN_PROGRESS', async () => {
            const mockResponse = { data: { id: 100 } };
            mockOctokit.checks.create.mockResolvedValue(mockResponse);

            const result = await service.createCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                headSha: 'sha123',
                name: 'test-check',
                status: CheckStatus.IN_PROGRESS,
                output: { title: 'Test', summary: 'Summary' },
            });

            expect(
                mockGithubService.getAuthenticatedOctokit,
            ).toHaveBeenCalledWith(mockOrganizationAndTeamData);
            expect(mockOctokit.checks.create).toHaveBeenCalledWith({
                owner: 'kodus-ai',
                repo: 'kodus',
                name: 'test-check',
                head_sha: 'sha123',
                status: 'in_progress',
                started_at: expect.any(String),
                output: { title: 'Test', summary: 'Summary' },
            });
            expect(result).toBe(100);
        });

        it('should return null on error', async () => {
            mockOctokit.checks.create.mockRejectedValue(new Error('Failed'));

            const result = await service.createCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                headSha: 'sha123',
                name: 'test-check',
                status: CheckStatus.IN_PROGRESS,
            } as any);

            expect(result).toBeNull();
        });

        // The installation lacks `checks:write` until the customer accepts the
        // new app permissions — a customer-side state, logged as error on
        // every PR (235/day).
        it('logs a missing checks permission as warn, not error', async () => {
            mockOctokit.checks.create.mockRejectedValue(
                Object.assign(
                    new Error('Resource not accessible by integration'),
                    { status: 403 },
                ),
            );
            const logger = (service as any).logger;
            logger.error = jest.fn();
            logger.warn = jest.fn();

            const result = await service.createCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                headSha: 'sha123',
                name: 'test-check',
                status: CheckStatus.IN_PROGRESS,
            } as any);

            expect(result).toBeNull();
            expect(logger.error).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({
                        organizationId: 'org-1',
                    }),
                }),
            );
        });
    });

    describe('updateCheckRun', () => {
        it('should update a check run with status COMPLETED and conclusion SUCCESS', async () => {
            mockOctokit.checks.update.mockResolvedValue({});

            const result = await service.updateCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                checkRunId: 100,
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.SUCCESS,
            });

            expect(mockOctokit.checks.update).toHaveBeenCalledWith({
                owner: 'kodus-ai',
                repo: 'kodus',
                check_run_id: 100,
                status: 'completed',
                conclusion: 'success',
            });
            expect(result).toBe(true);
        });

        it('should handle string checkRunId', async () => {
            mockOctokit.checks.update.mockResolvedValue({});

            await service.updateCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                checkRunId: '100',
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.SUCCESS,
            });

            expect(mockOctokit.checks.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    check_run_id: 100,
                }),
            );
        });

        it('should return false on error', async () => {
            mockOctokit.checks.update.mockRejectedValue(new Error('Failed'));

            const result = await service.updateCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                checkRunId: 100,
                status: CheckStatus.COMPLETED,
            });

            expect(result).toBe(false);
        });
    });
    describe('findLatestCompletedCheckRun', () => {
        const params = {
            organizationAndTeamData: mockOrganizationAndTeamData,
            repository: mockRepository,
            headSha: 'head-sha',
            name: 'Kody Code Review',
        };

        it('returns the most recently completed run, ignoring order and runs still in progress', async () => {
            mockOctokit.checks.listForRef.mockResolvedValue({
                data: {
                    check_runs: [
                        {
                            id: 1,
                            status: 'completed',
                            conclusion: 'failure',
                            completed_at: '2026-11-05T10:00:00Z',
                            html_url: 'https://github.com/run/1',
                            output: {
                                title: 'Code Review Failed',
                                summary: 'x',
                            },
                        },
                        {
                            id: 3,
                            status: 'in_progress',
                            conclusion: null,
                            completed_at: null,
                        },
                        {
                            id: 2,
                            status: 'completed',
                            conclusion: 'success',
                            completed_at: '2026-11-05T11:00:00Z',
                            html_url: 'https://github.com/run/2',
                            output: {
                                title: 'Code Review Complete',
                                summary: 'y',
                            },
                        },
                    ],
                },
            });

            const result = await service.findLatestCompletedCheckRun(params);

            expect(mockOctokit.checks.listForRef).toHaveBeenCalledWith({
                owner: 'kodus-ai',
                repo: 'kodus',
                ref: 'head-sha',
                check_name: 'Kody Code Review',
                status: 'completed',
                filter: 'all',
                app_id: 4242,
                per_page: 100,
            });
            expect(result).toEqual({
                id: 2,
                conclusion: 'success',
                title: 'Code Review Complete',
                htmlUrl: 'https://github.com/run/2',
            });
        });

        it('ignores a stale run, which cannot be posted again', async () => {
            mockOctokit.checks.listForRef.mockResolvedValue({
                data: {
                    check_runs: [
                        {
                            id: 5,
                            status: 'completed',
                            conclusion: 'stale',
                            completed_at: '2026-11-05T12:00:00Z',
                        },
                        {
                            id: 4,
                            status: 'completed',
                            conclusion: 'success',
                            completed_at: '2026-11-05T10:00:00Z',
                        },
                    ],
                },
            });

            await expect(
                service.findLatestCompletedCheckRun(params),
            ).resolves.toEqual(expect.objectContaining({ id: 4 }));
        });

        it("returns null without calling GitHub when this deployment's App id is unknown", async () => {
            mockGithubService.getGithubAppId.mockReturnValue(undefined);

            await expect(
                service.findLatestCompletedCheckRun(params),
            ).resolves.toBeNull();
            expect(mockOctokit.checks.listForRef).not.toHaveBeenCalled();
        });

        it('returns null when no run has completed', async () => {
            mockOctokit.checks.listForRef.mockResolvedValue({
                data: { check_runs: [] },
            });

            await expect(
                service.findLatestCompletedCheckRun(params),
            ).resolves.toBeNull();
        });

        it('returns null under PAT auth without calling GitHub', async () => {
            mockGithubService.getGithubAuthDetails.mockResolvedValue({
                authMode: AuthMode.TOKEN,
            } as any);

            await expect(
                service.findLatestCompletedCheckRun(params),
            ).resolves.toBeNull();
            expect(mockOctokit.checks.listForRef).not.toHaveBeenCalled();
        });

        it('throws when GitHub fails, so the caller can tell an error from no run', async () => {
            mockOctokit.checks.listForRef.mockRejectedValue(new Error('boom'));

            await expect(
                service.findLatestCompletedCheckRun(params),
            ).rejects.toThrow('boom');
        });
    });

    describe('createCompletedCheckRun', () => {
        it('creates a completed check run carrying the given conclusion', async () => {
            mockOctokit.checks.create.mockResolvedValue({ data: { id: 77 } });

            const result = await service.createCompletedCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                headSha: 'queue-sha',
                name: 'Kody Code Review',
                conclusion: 'neutral',
                detailsUrl: 'https://github.com/run/2',
                output: { title: 'Code Review Complete', summary: 's' },
            });

            expect(mockOctokit.checks.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    owner: 'kodus-ai',
                    repo: 'kodus',
                    name: 'Kody Code Review',
                    head_sha: 'queue-sha',
                    status: 'completed',
                    conclusion: 'neutral',
                    details_url: 'https://github.com/run/2',
                    output: { title: 'Code Review Complete', summary: 's' },
                }),
            );
            expect(result).toBe(77);
        });

        it('posts nothing under PAT auth, which has no Checks API', async () => {
            mockGithubService.getGithubAuthDetails.mockResolvedValue({
                authMode: AuthMode.TOKEN,
            } as any);

            await expect(
                service.createCompletedCheckRun({
                    organizationAndTeamData: mockOrganizationAndTeamData,
                    repository: mockRepository,
                    headSha: 'queue-sha',
                    name: 'Kody Code Review',
                    conclusion: 'failure',
                    output: { title: 't', summary: 's' },
                }),
            ).resolves.toBeNull();
            expect(mockOctokit.checks.create).not.toHaveBeenCalled();
        });

        it('throws when GitHub fails', async () => {
            mockOctokit.checks.create.mockRejectedValue(new Error('boom'));

            await expect(
                service.createCompletedCheckRun({
                    organizationAndTeamData: mockOrganizationAndTeamData,
                    repository: mockRepository,
                    headSha: 'queue-sha',
                    name: 'Kody Code Review',
                    conclusion: 'success',
                    output: { title: 't', summary: 's' },
                }),
            ).rejects.toThrow('boom');
        });
    });
    describe('findMergeQueueEntry', () => {
        const params = {
            organizationAndTeamData: mockOrganizationAndTeamData,
            repository: mockRepository,
            prNumber: 7,
        };

        it("returns the PR's own merge queue commit and the PR head, however deep the queue", async () => {
            mockOctokit.graphql.mockResolvedValue({
                repository: {
                    pullRequest: {
                        headRefOid: 'head-sha',
                        mergeQueueEntry: { headCommit: { oid: 'queue-sha' } },
                    },
                },
            });

            await expect(service.findMergeQueueEntry(params)).resolves.toEqual({
                queueSha: 'queue-sha',
                headSha: 'head-sha',
            });
            expect(mockOctokit.graphql).toHaveBeenCalledWith(
                expect.stringMatching(/headRefOid[\s\S]*mergeQueueEntry/),
                { owner: 'kodus-ai', name: 'kodus', number: 7 },
            );
            expect(mockOctokit.graphql).toHaveBeenCalledWith(
                expect.not.stringContaining('entries('),
                expect.anything(),
            );
        });

        it.each([
            ['the PR is not queued', { mergeQueueEntry: null }],
            ['the PR does not exist', null],
        ])('returns null when %s', async (_label, pullRequest) => {
            mockOctokit.graphql.mockResolvedValue({
                repository: { pullRequest },
            });

            await expect(
                service.findMergeQueueEntry(params),
            ).resolves.toBeNull();
        });

        it('turns a GraphQL rate limit into a RateLimitError at the reset time', async () => {
            const reset = Math.floor(Date.now() / 1000) + 900;
            mockOctokit.graphql.mockRejectedValue(
                Object.assign(new Error('API rate limit exceeded'), {
                    name: 'GraphqlResponseError',
                    errors: [
                        {
                            type: 'RATE_LIMITED',
                            message: 'API rate limit exceeded',
                        },
                    ],
                    headers: { 'x-ratelimit-reset': String(reset) },
                }),
            );

            const error = await service
                .findMergeQueueEntry(params)
                .catch((e) => e);

            expect(isRateLimitError(error)).toBe(true);
            expect(error.resetAt.getTime()).toBe(reset * 1000);
        });

        it('rethrows other GraphQL errors unchanged', async () => {
            const original = Object.assign(new Error('Something went wrong'), {
                name: 'GraphqlResponseError',
                errors: [{ type: 'INTERNAL', message: 'x' }],
            });
            mockOctokit.graphql.mockRejectedValue(original);

            await expect(service.findMergeQueueEntry(params)).rejects.toBe(
                original,
            );
        });
    });
});
