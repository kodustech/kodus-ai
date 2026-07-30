jest.mock('@libs/common/utils/thread-id', () => ({
    createThreadId: jest.fn(() => 'vbl-thread-id'),
}));

import {
    BadRequestException,
    HttpException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';

import { CliReviewController } from '@/core/infrastructure/http/controllers/cli/cli-review.controller';
import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { EnqueueCliReviewUseCase } from '@libs/cli-review/application/use-cases/enqueue-cli-review.use-case';
import { GetCliReviewJobStatusUseCase } from '@libs/cli-review/application/use-cases/get-cli-review-job-status.use-case';
import { WaitForCliReviewJobUseCase } from '@libs/cli-review/application/use-cases/wait-for-cli-review-job.use-case';
import { SubmitCliSessionCaptureUseCase } from '@libs/cli-review/application/use-cases/submit-cli-session-capture.use-case';
import { AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN } from '@libs/cli-review/domain/contracts/authenticated-rate-limiter.service.contract';
import { TRIAL_RATE_LIMITER_SERVICE_TOKEN } from '@libs/cli-review/domain/contracts/trial-rate-limiter.service.contract';
import { GITHUB_PUBLIC_PR_SERVICE_TOKEN } from '@libs/cli-review/domain/contracts/github-public-pr.service.contract';
import { AUTH_SERVICE_TOKEN } from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { CLI_DEVICE_SERVICE_TOKEN } from '@libs/organization/domain/cli-device/contracts/cli-device.service.contract';
import { TEAM_CLI_KEY_SERVICE_TOKEN } from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { TEAM_SERVICE_TOKEN } from '@libs/organization/domain/team/contracts/team.service.contract';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/agents/business-rules-validation/businessRulesValidationAgent';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { TriggerBusinessValidationUseCase } from '@libs/platform/application/use-cases/codeManagement/trigger-business-validation.use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { IngestSessionEventUseCase } from '@libs/cli-review/application/use-cases/ingest-session-event.use-case';
import { PublicPrReviewUseCase } from '@libs/cli-review/application/use-cases/public-pr-review.use-case';
import { ListFeaturedPublicReviewsUseCase } from '@libs/cli-review/application/use-cases/list-featured-public-reviews.use-case';
import { GetFeaturedPublicReviewUseCase } from '@libs/cli-review/application/use-cases/get-featured-public-review.use-case';
import { ValidateCliKeyUseCase } from '@libs/cli-review/application/use-cases/validate-cli-key.use-case';

describe('CLI business-validation integration', () => {
    let controller: CliReviewController;

    const mockTeamCliKeyService = {
        validateKey: jest.fn(),
    };
    const mockRateLimiter = {
        checkRateLimit: jest.fn(),
    };
    const mockCodeManagementService = {
        getPullRequests: jest.fn(),
        getTypeIntegration: jest.fn(),
    };
    const mockIntegrationConfigService = {
        findIntegrationConfigFormatted: jest.fn(),
    };
    const mockBusinessProvider = {
        execute: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CliReviewController,
                TriggerBusinessValidationUseCase,
                {
                    provide: ExecuteCliReviewUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: EnqueueCliReviewUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: GetCliReviewJobStatusUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: WaitForCliReviewJobUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: SubmitCliSessionCaptureUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: IngestSessionEventUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: TRIAL_RATE_LIMITER_SERVICE_TOKEN,
                    useValue: {
                        checkRateLimit: jest.fn(),
                        getRateLimitStatus: jest.fn(),
                    },
                },
                {
                    provide: AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN,
                    useValue: mockRateLimiter,
                },
                // Public-demo deps — only the trial endpoints touch
                // these; mocked so Nest can resolve the constructor.
                {
                    provide: GITHUB_PUBLIC_PR_SERVICE_TOKEN,
                    useValue: { fetch: jest.fn() },
                },
                {
                    provide: PublicPrReviewUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: ListFeaturedPublicReviewsUseCase,
                    useValue: {
                        execute: jest.fn().mockResolvedValue({ items: [] }),
                    },
                },
                {
                    provide: GetFeaturedPublicReviewUseCase,
                    useValue: {
                        execute: jest.fn().mockResolvedValue(null),
                    },
                },
                ValidateCliKeyUseCase,
                {
                    provide: TEAM_CLI_KEY_SERVICE_TOKEN,
                    useValue: mockTeamCliKeyService,
                },
                {
                    provide: TEAM_SERVICE_TOKEN,
                    useValue: {
                        findById: jest.fn(),
                        findFirstCreatedTeam: jest.fn(),
                    },
                },
                {
                    provide: AUTH_SERVICE_TOKEN,
                    useValue: { validateUser: jest.fn() },
                },
                {
                    provide: CLI_DEVICE_SERVICE_TOKEN,
                    useValue: { validateOrRegisterDevice: jest.fn() },
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: mockIntegrationConfigService,
                },
                {
                    provide: BusinessRulesValidationAgentProvider,
                    useValue: mockBusinessProvider,
                },
                {
                    provide: JwtService,
                    useValue: { verify: jest.fn() },
                },
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest
                            .fn()
                            .mockReturnValue({ secret: 'test-secret' }),
                    },
                },
            ],
        }).compile();

        controller = module.get(CliReviewController);

        jest.clearAllMocks();

        mockTeamCliKeyService.validateKey.mockResolvedValue({
            team: { uuid: 'team-1', name: 'Platform Team' },
            organization: { uuid: 'org-1', name: 'Kodus' },
        });
        mockRateLimiter.checkRateLimit.mockResolvedValue({
            allowed: true,
            remaining: 999,
            resetAt: null,
        });
        mockCodeManagementService.getTypeIntegration.mockResolvedValue(
            PlatformType.GITHUB,
        );
        mockBusinessProvider.execute.mockResolvedValue(
            '## Business Rules Validation\n\nLooks good.',
        );
        mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
            [{ id: 'repo-1', name: 'kodus-ai', organizationName: 'kodus-ai' }],
        );
    });

    it('executes provider flow when called with prUrl and taskId', async () => {
        const prUrl = 'https://github.com/kodus-ai/kodus-ai/pull/42';

        mockCodeManagementService.getPullRequests.mockResolvedValue([
            {
                number: 42,
                prURL: prUrl,
                body: 'Implements new business-validation endpoint.',
                repositoryData: { id: 'repo-1', name: 'kodus-ai' },
                head: { ref: 'feat/business-validation' },
                base: { ref: 'main', repo: { defaultBranch: 'main' } },
            },
        ]);

        const result = await controller.businessValidation(
            { prUrl, taskId: 'KD-1234' },
            'kodus_test_key',
            undefined,
            undefined,
        );

        expect(result).toMatchObject({
            accepted: true,
            mode: 'pull_request',
            prNumber: 42,
            prUrl,
            repositoryId: 'repo-1',
            repositoryName: 'kodus-ai',
            taskReference: 'KD-1234',
            result: '## Business Rules Validation\n\nLooks good.',
        });
        expect(mockRateLimiter.checkRateLimit).toHaveBeenCalledWith('team-1');
        expect(mockBusinessProvider.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                thread: 'vbl-thread-id',
                prepareContext: expect.objectContaining({
                    userQuestion: '@kody -v business-logic KD-1234',
                    taskId: 'KD-1234',
                    taskReference: 'KD-1234',
                    platformType: PlatformType.GITHUB,
                    pullRequest: expect.objectContaining({
                        pullRequestNumber: 42,
                    }),
                    repository: expect.objectContaining({
                        id: 'repo-1',
                        name: 'kodus-ai',
                    }),
                }),
            }),
        );
    });

    it('resolves repository and pull request when called with prNumber and repositoryId', async () => {
        mockCodeManagementService.getPullRequests.mockResolvedValue([
            {
                number: 77,
                prURL: 'https://github.com/kodus-ai/kodus-ai/pull/77',
                body: 'Sync business rules validation through provider.',
                head: { ref: 'feat/rules' },
                base: { ref: 'main' },
            },
        ]);

        const result = await controller.businessValidation(
            {
                prNumber: 77,
                repositoryId: 'repo-1',
                taskUrl: 'https://linear.app/kodus/issue/KD-77',
            },
            'kodus_test_key',
            undefined,
            undefined,
        );

        expect(result).toMatchObject({
            accepted: true,
            mode: 'pull_request',
            prNumber: 77,
            repositoryId: 'repo-1',
            repositoryName: 'kodus-ai',
            taskReference: 'https://linear.app/kodus/issue/KD-77',
        });
        expect(mockCodeManagementService.getPullRequests).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: { id: 'repo-1', name: 'kodus-ai' },
                filters: { number: 77 },
            }),
        );
        expect(mockBusinessProvider.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                prepareContext: expect.objectContaining({
                    taskUrl: 'https://linear.app/kodus/issue/KD-77',
                    taskReference: 'https://linear.app/kodus/issue/KD-77',
                }),
            }),
        );
    });

    it('executes provider flow when called with local diff only', async () => {
        const diff = [
            'diff --git a/src/service.ts b/src/service.ts',
            'index 1111111..2222222 100644',
            '--- a/src/service.ts',
            '+++ b/src/service.ts',
            '@@ -1,3 +1,5 @@',
            "+const TASK = 'KD-1234';",
        ].join('\n');

        const result = await controller.businessValidation(
            {
                diff,
                taskId: 'KD-1234',
                repository: 'kodus-ai/kodus-ai',
            },
            'kodus_test_key',
            undefined,
            undefined,
        );

        expect(result).toMatchObject({
            accepted: true,
            mode: 'local_diff',
            repositoryId: 'repo-1',
            repositoryName: 'kodus-ai',
            taskReference: 'KD-1234',
            result: '## Business Rules Validation\n\nLooks good.',
        });

        const providerPayload = mockBusinessProvider.execute.mock.calls[0][0];
        expect(providerPayload.prepareContext).toMatchObject({
            userQuestion: '@kody -v business-logic KD-1234',
            taskId: 'KD-1234',
            taskReference: 'KD-1234',
            pullRequestDescription:
                'Local diff validation requested for task: KD-1234',
            prDiff: diff,
            repository: {
                id: 'repo-1',
                name: 'kodus-ai',
            },
        });
        expect(providerPayload.prepareContext.pullRequest).toBeUndefined();
        expect(
            mockCodeManagementService.getPullRequests,
        ).not.toHaveBeenCalled();
    });

    it('returns 401 when team key is invalid', async () => {
        mockTeamCliKeyService.validateKey.mockResolvedValue(null);

        await expect(
            controller.businessValidation(
                { prUrl: 'https://github.com/kodus-ai/kodus-ai/pull/42' },
                'kodus_invalid_key',
                undefined,
                undefined,
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockBusinessProvider.execute).not.toHaveBeenCalled();
    });

    it('returns 429 when authenticated rate limit is exceeded', async () => {
        mockRateLimiter.checkRateLimit.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: new Date('2026-03-04T19:00:00.000Z'),
        });

        mockCodeManagementService.getPullRequests.mockResolvedValue([
            {
                number: 42,
                prURL: 'https://github.com/kodus-ai/kodus-ai/pull/42',
                body: 'Some description',
                repositoryData: { id: 'repo-1', name: 'kodus-ai' },
            },
        ]);

        await expect(
            controller.businessValidation(
                { prUrl: 'https://github.com/kodus-ai/kodus-ai/pull/42' },
                'kodus_test_key',
                undefined,
                undefined,
            ),
        ).rejects.toBeInstanceOf(HttpException);

        expect(
            mockCodeManagementService.getPullRequests,
        ).not.toHaveBeenCalled();
    });

    it('propagates use-case validation errors for invalid request body', async () => {
        await expect(
            controller.businessValidation(
                { taskId: 'KD-0001' },
                'kodus_test_key',
                undefined,
                undefined,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(mockBusinessProvider.execute).not.toHaveBeenCalled();
    });
});
