import { Test, TestingModule } from '@nestjs/testing';

import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { AutoAssignLicenseUseCase } from '@libs/ee/license/use-cases/auto-assign-license.use-case';
import {
    PermissionValidationService,
    ValidationErrorType,
} from '@libs/ee/shared/services/permissionValidation.service';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationRateLimiter } from '@libs/notifications/application/notification-rate-limiter.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { USER_SERVICE_TOKEN } from '@libs/identity/domain/user/contracts/user.service.contract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { ValidatePrerequisitesStage } from './validate-prerequisites.stage';

describe('ValidatePrerequisitesStage', () => {
    let stage: ValidatePrerequisitesStage;

    let mockPermissionValidationService: {
        validateExecutionPermissions: jest.Mock;
    };
    let mockAutoAssignLicenseUseCase: {
        execute: jest.Mock;
    };
    let mockOrganizationParametersService: {
        findByKey: jest.Mock;
    };
    let mockParametersService: {
        findByKey: jest.Mock;
    };
    let mockPullRequestsService: {
        find: jest.Mock;
    };
    let mockCodeManagementService: {
        addReactionToPR: jest.Mock;
        addReactionToComment: jest.Mock;
        createIssueComment: jest.Mock;
        createResponseToComment: jest.Mock;
    };

    const makeContext = (): CodeReviewPipelineContext =>
        ({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            repository: {
                id: 'repo-1',
                name: 'repo-1',
            } as any,
            pullRequest: {
                number: 42,
                state: 'open',
                locked: false,
            } as any,
            userGitId: 'user-1',
            platformType: PlatformType.GITHUB,
            branch: 'feature/test',
            teamAutomationId: 'automation-1',
            origin: 'opened',
            action: 'opened',
            dryRun: { enabled: false },
            errors: [],
            preparedFileContexts: [],
            validSuggestions: [],
            discardedSuggestions: [],
            validSuggestionsByPR: [],
            validCrossFileSuggestions: [],
            pipelineMetadata: {},
            statusInfo: {
                status: 'in_progress' as any,
                message: 'started',
            },
            pipelineVersion: '1.0.0',
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        mockPermissionValidationService = {
            validateExecutionPermissions: jest.fn(),
        };

        mockAutoAssignLicenseUseCase = {
            execute: jest.fn(),
        };

        mockOrganizationParametersService = {
            findByKey: jest.fn().mockResolvedValue(undefined),
        };

        mockParametersService = {
            findByKey: jest.fn(),
        };

        mockPullRequestsService = {
            find: jest.fn().mockResolvedValue([]),
        };

        mockCodeManagementService = {
            addReactionToPR: jest.fn().mockResolvedValue(undefined),
            addReactionToComment: jest.fn().mockResolvedValue(undefined),
            createIssueComment: jest.fn().mockResolvedValue(undefined),
            createResponseToComment: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidatePrerequisitesStage,
                {
                    provide: PermissionValidationService,
                    useValue: mockPermissionValidationService,
                },
                {
                    provide: AutoAssignLicenseUseCase,
                    useValue: mockAutoAssignLicenseUseCase,
                },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: mockOrganizationParametersService,
                },
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
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
                    provide: NotificationService,
                    useValue: { emit: jest.fn().mockResolvedValue(undefined) },
                },
                {
                    provide: NotificationRateLimiter,
                    useValue: {
                        shouldEmit: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: PrAuthorRecipientResolver,
                    useValue: { resolve: jest.fn().mockResolvedValue(null) },
                },
                {
                    provide: USER_SERVICE_TOKEN,
                    useValue: { find: jest.fn().mockResolvedValue([]) },
                },
            ],
        }).compile();

        stage = module.get<ValidatePrerequisitesStage>(
            ValidatePrerequisitesStage,
        );
    });

    it('should not add no-license reaction when show status feedback is disabled', async () => {
        const context = makeContext();

        mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
            {
                allowed: false,
                errorType: ValidationErrorType.USER_NOT_LICENSED,
            },
        );

        mockAutoAssignLicenseUseCase.execute.mockResolvedValue({
            shouldProceed: false,
            reason: 'NOT_ENOUGH_PRS',
        });

        mockParametersService.findByKey.mockResolvedValue({
            configValue: {
                configs: {
                    showStatusFeedback: false,
                },
                repositories: [],
            },
        });

        await stage.execute(context);

        expect(mockParametersService.findByKey).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            context.organizationAndTeamData,
        );
        expect(
            mockCodeManagementService.addReactionToPR,
        ).not.toHaveBeenCalled();
        expect(
            mockCodeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
    });

    it('should not add no-subscription comment when show status feedback is disabled', async () => {
        const context = makeContext();

        mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
            {
                allowed: false,
                errorType: ValidationErrorType.INVALID_LICENSE,
            },
        );

        mockParametersService.findByKey.mockResolvedValue({
            configValue: {
                configs: {
                    showStatusFeedback: false,
                },
                repositories: [],
            },
        });

        await stage.execute(context);

        expect(
            mockCodeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
        expect(
            mockCodeManagementService.addReactionToPR,
        ).not.toHaveBeenCalled();
    });

    it('should mark notification as handled for early skips when show status feedback is disabled', async () => {
        const context = makeContext();

        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: {
                ignoredUsers: ['user-1'],
            },
        });

        mockParametersService.findByKey.mockResolvedValue({
            configValue: {
                configs: {
                    showStatusFeedback: false,
                },
                repositories: [],
            },
        });

        const result = await stage.execute(context);

        expect(result.pipelineMetadata?.notificationHandled).toBe(true);
        expect(result.pipelineMetadata?.showStatusFeedback).toBe(false);
    });

    it('should skip review for centralized config repository when centralized config is enabled', async () => {
        const context = makeContext();
        context.repository.id = 'centralized-config-repo';

        mockParametersService.findByKey.mockImplementation((key: string) => {
            if (key === ParametersKey.CENTRALIZED_CONFIG) {
                return Promise.resolve({
                    configValue: {
                        enabled: true,
                        repository: { id: 'centralized-config-repo' },
                    },
                });
            }

            return Promise.resolve(undefined);
        });

        const result = await stage.execute(context);

        expect(result.statusInfo?.status).toBe('skipped');
        expect(result.statusInfo?.message).toBe(
            'Code reviews are disabled for the centralized config repository',
        );
        expect(
            mockPermissionValidationService.validateExecutionPermissions,
        ).not.toHaveBeenCalled();
    });

    it('should not skip review for non-centralized config repository when centralized config is enabled', async () => {
        const context = makeContext();
        context.repository.id = 'non-centralized-config-repo';

        mockParametersService.findByKey.mockImplementation((key: string) => {
            if (key === ParametersKey.CENTRALIZED_CONFIG) {
                return Promise.resolve({
                    configValue: {
                        enabled: true,
                        repository: { id: 'centralized-config-repo' },
                    },
                });
            }

            return Promise.resolve(undefined);
        });

        mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
            {
                allowed: true,
                errorType: ValidationErrorType.NOT_ERROR,
            },
        );

        await stage.execute(context);

        expect(
            mockPermissionValidationService.validateExecutionPermissions,
        ).toHaveBeenCalled();
    });

    describe('SKIPPED status contract', () => {
        it('marks the pipeline SKIPPED with a subscription-related message when license is invalid', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.INVALID_LICENSE,
                },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            const result = await stage.execute(context);

            expect(result.statusInfo?.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo?.message?.toLowerCase()).toMatch(
                /(license|subscription)/,
            );
        });

        it('marks the pipeline SKIPPED with a USER_NO_LICENSE reason when user is not licensed and auto-assign is unavailable', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.USER_NOT_LICENSED,
                },
            );
            mockAutoAssignLicenseUseCase.execute.mockResolvedValue({
                shouldProceed: false,
                reason: 'NOT_ENOUGH_PRS',
            });
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            const result = await stage.execute(context);

            expect(result.statusInfo?.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo?.message?.toLowerCase()).toMatch(
                /(license|subscription|seat)/,
            );
        });

        it('marks the pipeline SKIPPED with USER_IGNORED message when the user is in the ignored list', async () => {
            const context = makeContext();

            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { ignoredUsers: ['user-1'] },
            });
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            const result = await stage.execute(context);

            expect(result.statusInfo?.status).toBe(AutomationStatus.SKIPPED);
            // USER_IGNORED constant from AutomationMessage
            expect(result.statusInfo?.message).toBeDefined();
            expect(
                mockPermissionValidationService.validateExecutionPermissions,
            ).not.toHaveBeenCalled();
        });

        it('does NOT mark SKIPPED on the happy path (license valid, user not ignored)', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                { allowed: true, errorType: ValidationErrorType.NOT_ERROR },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            const result = await stage.execute(context);

            // statusInfo not changed from in_progress
            expect(result.statusInfo?.status).not.toBe(
                AutomationStatus.SKIPPED,
            );
        });
    });

    describe('trial review credit consumption', () => {
        it('asks to consume a managed trial credit keyed by repo:pr', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                { allowed: true },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            await stage.execute(context);

            expect(
                mockPermissionValidationService.validateExecutionPermissions,
            ).toHaveBeenCalledWith(
                context.organizationAndTeamData,
                'user-1',
                ValidatePrerequisitesStage.name,
                {
                    consumeTrialReviewCredit: true,
                    trialReviewCreditUsageKey: 'repo-1:42',
                },
            );
        });

        it('posts a BYOK-focused comment (not "trial ended") when trial credits run out', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.PLAN_LIMIT_EXCEEDED,
                    subscriptionStatus: 'trial',
                },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            await stage.execute(context);

            const body =
                mockCodeManagementService.createIssueComment.mock.calls[0][0]
                    .body;
            expect(body).toContain('Kodus-paid PR reviews');
            expect(body).toContain('/organization/byok');
            expect(body).not.toContain('trial has ended');
        });
    });
});
