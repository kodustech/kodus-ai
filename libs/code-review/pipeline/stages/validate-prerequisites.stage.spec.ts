import { isKodyAuthoredBody } from '@libs/common/utils/kody-identifiers';
import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { Test, TestingModule } from '@nestjs/testing';

import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { AutoAssignLicenseUseCase } from '@libs/ee/license/use-cases/auto-assign-license.use-case';
import { LICENSE_SERVICE_TOKEN } from '@libs/ee/license/interfaces/license.interface';
import {
    PermissionValidationService,
    ValidationErrorType,
} from '@libs/ee/shared/services/permissionValidation.service';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationRateLimiter } from '@libs/notifications/application/notification-rate-limiter.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { USER_SERVICE_TOKEN } from '@libs/identity/domain/user/contracts/user.service.contract';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import {
    licenseNoticeBody,
    ValidatePrerequisitesStage,
} from './validate-prerequisites.stage';

// The trial is provisioned cloud-only (the stage early-returns unless
// environment.API_CLOUD_MODE). Force cloud mode on so the trial path runs.
jest.mock('@libs/ee/configs/environment', () => {
    const actual = jest.requireActual('@libs/ee/configs/environment');
    return {
        ...actual,
        environment: { ...actual.environment, API_CLOUD_MODE: true },
    };
});

describe('ValidatePrerequisitesStage', () => {
    let stage: ValidatePrerequisitesStage;

    let mockPermissionValidationService: {
        validateExecutionPermissions: jest.Mock;
        getBYOKConfig: jest.Mock;
        resolveTaskSlot: jest.Mock;
    };
    let mockLicenseService: {
        startTrial: jest.Mock;
        getAllUsersWithLicense: jest.Mock;
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
        countByAuthor: jest.Mock;
    };
    let mockCodeBaseConfigService: {
        getConfig: jest.Mock;
        getKodusConfigFile: jest.Mock;
    };
    let mockPullRequestManagerService: { getChangedFilesMetadata: jest.Mock };
    let mockAutomationExecutionService: {
        hasPullRequestExecutionWithDataKey: jest.Mock;
    };
    let mockCodeManagementService: {
        addReactionToPR: jest.Mock;
        addReactionToComment: jest.Mock;
        createIssueComment: jest.Mock;
        createResponseToComment: jest.Mock;
    };

    // Frozen by DEFAULT — production hands every stage after the first
    // produce() a deep-frozen context. See test/fixtures/frozen-pipeline-context.ts.
    const makeContext = (
        over: Record<string, unknown> = {},
    ): CodeReviewPipelineContext =>
        frozenContext({
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
            ...over,
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        mockPermissionValidationService = {
            validateExecutionPermissions: jest.fn(),
            getBYOKConfig: jest.fn().mockResolvedValue(null),
            // native "is BYOK?" heal check resolves the codeReview carrier via
            // the per-task API; null → env/managed default (no client BYOK).
            resolveTaskSlot: jest.fn().mockResolvedValue(null),
        };

        mockLicenseService = {
            startTrial: jest.fn().mockResolvedValue(false),
            getAllUsersWithLicense: jest.fn().mockResolvedValue([]),
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
            countByAuthor: jest.fn().mockResolvedValue(0),
        };

        mockCodeManagementService = {
            addReactionToPR: jest.fn().mockResolvedValue(undefined),
            addReactionToComment: jest.fn().mockResolvedValue(undefined),
            createIssueComment: jest.fn().mockResolvedValue(undefined),
            createResponseToComment: jest.fn().mockResolvedValue(undefined),
        };

        mockCodeBaseConfigService = {
            getConfig: jest
                .fn()
                .mockResolvedValue({ automatedReviewActive: true }),
            getKodusConfigFile: jest.fn().mockResolvedValue(undefined),
        };

        mockPullRequestManagerService = {
            getChangedFilesMetadata: jest
                .fn()
                .mockResolvedValue([{ filename: 'src/a.ts' }]),
        };

        mockAutomationExecutionService = {
            hasPullRequestExecutionWithDataKey: jest
                .fn()
                .mockResolvedValue(false),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidatePrerequisitesStage,
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: mockAutomationExecutionService,
                },
                {
                    provide: CODE_BASE_CONFIG_SERVICE_TOKEN,
                    useValue: mockCodeBaseConfigService,
                },
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: mockPullRequestManagerService,
                },
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
                {
                    provide: LICENSE_SERVICE_TOKEN,
                    useValue: mockLicenseService,
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

    it('auto-provisions a missing trial and re-validates for an onboarded org', async () => {
        const context = makeContext();

        mockPermissionValidationService.validateExecutionPermissions
            .mockResolvedValueOnce({
                allowed: false,
                errorType: ValidationErrorType.INVALID_LICENSE,
            })
            .mockResolvedValueOnce({
                allowed: true,
                subscriptionStatus: 'trial',
            });

        mockParametersService.findByKey.mockImplementation((key: string) => {
            if (key === ParametersKey.PLATFORM_CONFIGS) {
                return Promise.resolve({
                    configValue: { finishOnboard: true },
                });
            }
            return Promise.resolve(undefined);
        });

        mockLicenseService.startTrial.mockResolvedValue(true);

        const result = await stage.execute(context);

        expect(mockLicenseService.startTrial).toHaveBeenCalledWith(
            context.organizationAndTeamData,
            false,
        );
        // Validated once (INVALID_LICENSE), then again after provisioning.
        expect(
            mockPermissionValidationService.validateExecutionPermissions,
        ).toHaveBeenCalledTimes(2);
        // Review proceeds instead of being skipped for a missing license.
        expect(result.statusInfo?.status).not.toBe('skipped');
        expect(
            mockCodeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
    });

    // Billing answers 409 for an org that already has a license, and startTrial
    // treats 409 as success — so a canceled org re-ran the heal on every PR,
    // logged "POST trial failed" and a false "Auto-provisioned" (204/day).
    it('does not provision a trial for an org whose license exists but is canceled', async () => {
        const context = makeContext();

        mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
            {
                allowed: false,
                errorType: ValidationErrorType.INVALID_LICENSE,
                metadata: {
                    validation: {
                        valid: false,
                        subscriptionStatus: 'canceled',
                    },
                },
            },
        );
        mockParametersService.findByKey.mockImplementation((key: string) => {
            if (key === ParametersKey.PLATFORM_CONFIGS) {
                return Promise.resolve({
                    configValue: { finishOnboard: true },
                });
            }
            return Promise.resolve(undefined);
        });

        const result = await stage.execute(context);

        expect(mockLicenseService.startTrial).not.toHaveBeenCalled();
        expect(result.statusInfo?.status).toBe('skipped');
    });

    it('does not provision a trial when onboarding is not finished', async () => {
        const context = makeContext();

        mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
            {
                allowed: false,
                errorType: ValidationErrorType.INVALID_LICENSE,
            },
        );

        // No PLATFORM_CONFIGS / finishOnboard flag → onboarding not complete.
        mockParametersService.findByKey.mockResolvedValue(undefined);

        const result = await stage.execute(context);

        expect(mockLicenseService.startTrial).not.toHaveBeenCalled();
        expect(
            mockPermissionValidationService.validateExecutionPermissions,
        ).toHaveBeenCalledTimes(1);
        expect(result.statusInfo?.status).toBe('skipped');
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
        // Override at build time: the context is frozen, like production.
        const context = makeContext({
            repository: { id: 'centralized-config-repo', name: 'repo-1' },
        });

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
        // Override at build time: the context is frozen, like production.
        const context = makeContext({
            repository: { id: 'non-centralized-config-repo', name: 'repo-1' },
        });

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

        // Bots are auto-populated into ignoredUsers when an integration is
        // created, so an app that authors PRs starts out ignored. Paying for
        // a seat is the clearest possible statement that this identity should
        // be reviewed, so it has to win over the filter.
        it('reviews an ignored identity that holds a seat instead of skipping it', async () => {
            const context = makeContext();

            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { ignoredUsers: ['user-1'] },
            });
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'user-1' },
            ]);
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

            expect(result.statusInfo?.status).not.toBe(
                AutomationStatus.SKIPPED,
            );
            expect(
                mockPermissionValidationService.validateExecutionPermissions,
            ).toHaveBeenCalled();
        });

        it('reviews an identity excluded by allowedUsers when it holds a seat', async () => {
            const context = makeContext();

            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { allowedUsers: ['someone-else'] },
            });
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'user-1' },
            ]);
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

            expect(result.statusInfo?.status).not.toBe(
                AutomationStatus.SKIPPED,
            );
        });

        it('keeps skipping an ignored identity when the seat lookup fails', async () => {
            const context = makeContext();

            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { ignoredUsers: ['user-1'] },
            });
            mockLicenseService.getAllUsersWithLicense.mockRejectedValue(
                new Error('billing unreachable'),
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            const result = await stage.execute(context);

            expect(result.statusInfo?.status).toBe(AutomationStatus.SKIPPED);
        });

        // The seat list is fetched to decide whether the ignore list applies;
        // handing it to the permission check reuses it instead of paying a
        // second round trip to billing for the same answer.
        it('reuses the seat list it already fetched for the permission check', async () => {
            const context = makeContext();
            const seats = [{ git_id: 'user-1' }];

            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { ignoredUsers: ['user-1'] },
            });
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue(seats);
            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                { allowed: true, errorType: ValidationErrorType.NOT_ERROR },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            await stage.execute(context);

            expect(
                mockLicenseService.getAllUsersWithLicense,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockPermissionValidationService.validateExecutionPermissions,
            ).toHaveBeenCalledWith(
                expect.anything(),
                'user-1',
                expect.any(String),
                expect.objectContaining({ usersWithLicense: seats }),
            );
        });

        it('does not look up seats when the identity is not filtered out', async () => {
            const context = makeContext();

            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { ignoredUsers: ['somebody-else'] },
            });
            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                { allowed: true, errorType: ValidationErrorType.NOT_ERROR },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            await stage.execute(context);

            expect(
                mockLicenseService.getAllUsersWithLicense,
            ).not.toHaveBeenCalled();
        });
    });

    describe('trial review credit consumption', () => {
        it('gates on trial credits WITHOUT consuming (consumption is deferred to a successful review)', async () => {
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

            const result = await stage.execute(context);

            // Happy path (license valid, user not ignored): not skipped.
            expect(result.statusInfo?.status).not.toBe(
                AutomationStatus.SKIPPED,
            );
            // Prerequisites only checks whether credits remain — it must NOT
            // consume one up-front, or a review that later ERRORs/SKIPs would
            // still cost the user a free trial review. The consume happens in
            // CodeReviewHandlerService once the review reaches SUCCESS/PARTIAL_ERROR.
            expect(
                mockPermissionValidationService.validateExecutionPermissions,
            ).toHaveBeenCalledWith(
                context.organizationAndTeamData,
                'user-1',
                ValidatePrerequisitesStage.name,
                {
                    consumeTrialReviewCredit: false,
                },
            );
        });

        it('posts a BYOK-focused comment and a trial-specific SKIPPED status when trial credits run out', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.PLAN_LIMIT_EXCEEDED,
                    subscriptionStatus: 'trial',
                    metadata: { trialCreditsExhausted: true },
                },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            const result = await stage.execute(context);

            const body =
                mockCodeManagementService.createIssueComment.mock.calls[0][0]
                    .body;
            expect(body).toContain('Kodus-paid PR reviews');
            expect(body).toContain('/byok');
            expect(body).not.toContain('trial has ended');
            expect(result.statusInfo?.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo?.message).toContain('Trial Reviews Used Up');
            expect(result.statusInfo?.message).not.toContain(
                'Plan Limit Exceeded',
            );
        });

        it('posts a top-up comment (not BYOK-required, not trial-ended) when Kodus credits are exhausted', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.CREDITS_EXHAUSTED,
                    subscriptionStatus: 'active',
                    metadata: { creditsExhausted: true, creditBalanceUsd: 0 },
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
            expect(body).toContain('Kodus credits');
            expect(body).toContain('/byok#kodus');
            expect(body).not.toContain('BYOK Configuration Required');
            expect(body).not.toContain('trial has ended');
        });

        it('posts a "subscription check unavailable" message (not credits, not trial-ended) on a transient billing failure', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.PLAN_LIMIT_EXCEEDED,
                    subscriptionStatus: 'trial',
                    metadata: { trialCreditsExhausted: false },
                },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            const result = await stage.execute(context);

            const body =
                mockCodeManagementService.createIssueComment.mock.calls[0][0]
                    .body;
            expect(body).toContain('Subscription check unavailable');
            expect(body).not.toContain('Kodus-paid PR reviews');
            expect(body).not.toContain('trial has ended');
            expect(result.statusInfo?.message).toContain(
                'Subscription Check Unavailable',
            );
            expect(result.statusInfo?.message).not.toContain(
                'Trial Reviews Used Up',
            );
        });

        it('posts "subscription check unavailable" when the license read itself failed, and never tries to provision a trial', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.LICENSE_UNAVAILABLE,
                    metadata: {
                        validation: { valid: false, unavailable: true },
                    },
                },
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            });

            const result = await stage.execute(context);

            const body =
                mockCodeManagementService.createIssueComment.mock.calls[0][0]
                    .body;
            expect(body).toContain('Subscription check unavailable');
            expect(body).not.toContain('trial has ended');
            expect(result.statusInfo?.message).toContain(
                'Subscription Check Unavailable',
            );
            // A failed read must not reach the "missing trial" heal: that path
            // would POST /trial while billing is already failing.
            expect(mockLicenseService.startTrial).not.toHaveBeenCalled();
            expect(
                mockPermissionValidationService.validateExecutionPermissions,
            ).toHaveBeenCalledTimes(1);
        });

        it('keeps the generic "Plan Limit Exceeded" SKIPPED status for a non-trial plan limit', async () => {
            const context = makeContext();

            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.PLAN_LIMIT_EXCEEDED,
                    subscriptionStatus: 'active',
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
            expect(result.statusInfo?.message).toContain('Plan Limit Exceeded');
        });
    });

    describe('license auto-assign when automated review is off', () => {
        const unlicensed = () =>
            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.USER_NOT_LICENSED,
                },
            );

        // A repository picked by hand has its own entry in the code review
        // config; one added by "review all repositories" may not have one
        // yet and inherits the global settings.
        describe.each([
            {
                selection: 'repository with its own config entry',
                repositories: [{ id: 'repo-1', configs: {} }],
            },
            {
                selection: 'discovered repository without a config entry',
                repositories: [],
            },
        ])('$selection', ({ repositories }) => {
            beforeEach(() => {
                mockParametersService.findByKey.mockResolvedValue({
                    configValue: { configs: {}, repositories },
                });
            });

            it('skips without assigning a seat when the effective setting is off', async () => {
                unlicensed();
                mockCodeBaseConfigService.getConfig.mockResolvedValue({
                    automatedReviewActive: false,
                });

                const result = await stage.execute(makeContext());

                expect(
                    mockAutoAssignLicenseUseCase.execute,
                ).not.toHaveBeenCalled();
                expect(result.statusInfo.status).toBe(
                    AutomationStatus.SKIPPED,
                );
                expect(
                    mockCodeManagementService.addReactionToPR,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.createIssueComment,
                ).not.toHaveBeenCalled();
            });

            it("hands auto-assign the author's PR count, counted no further than 2", async () => {
                unlicensed();
                mockPullRequestsService.countByAuthor.mockResolvedValue(2);
                mockAutoAssignLicenseUseCase.execute.mockResolvedValue({
                    shouldProceed: true,
                    reason: 'ASSIGNED',
                });
                const context = makeContext();

                await stage.execute(context);

                expect(
                    mockPullRequestsService.countByAuthor,
                ).toHaveBeenCalledWith(
                    context.organizationAndTeamData.organizationId,
                    String(context.userGitId),
                    2,
                );
                expect(mockPullRequestsService.find).not.toHaveBeenCalled();
                expect(mockAutoAssignLicenseUseCase.execute).toHaveBeenCalledWith(
                    expect.objectContaining({ prCount: 2 }),
                );
            });

            it('assigns the seat as before when the effective setting is on', async () => {
                unlicensed();
                mockAutoAssignLicenseUseCase.execute.mockResolvedValue({
                    shouldProceed: true,
                    reason: 'ASSIGNED',
                });

                const result = await stage.execute(makeContext());

                expect(
                    mockAutoAssignLicenseUseCase.execute,
                ).toHaveBeenCalledTimes(1);
                expect(result.statusInfo.status).not.toBe(
                    AutomationStatus.SKIPPED,
                );
            });
        });

        it('resolves the effective setting from the PR files, so directory and kodus-config.yml overrides apply', async () => {
            unlicensed();
            mockAutoAssignLicenseUseCase.execute.mockResolvedValue({
                shouldProceed: true,
                reason: 'ASSIGNED',
            });
            const context = makeContext();

            await stage.execute(context);

            expect(
                mockPullRequestManagerService.getChangedFilesMetadata,
            ).toHaveBeenCalledWith(
                context.organizationAndTeamData,
                context.repository,
                context.pullRequest,
            );
            expect(mockCodeBaseConfigService.getConfig).toHaveBeenCalledWith(
                context.organizationAndTeamData,
                context.repository,
                [{ filename: 'src/a.ts' }],
            );
        });

        it.each(['command', 'command-force'])(
            'keeps auto-assign for an explicit %s even when automated review is off',
            async (origin) => {
                unlicensed();
                mockCodeBaseConfigService.getConfig.mockResolvedValue({
                    automatedReviewActive: false,
                });
                mockAutoAssignLicenseUseCase.execute.mockResolvedValue({
                    shouldProceed: true,
                    reason: 'ASSIGNED',
                });

                await stage.execute(makeContext({ origin }));

                expect(
                    mockAutoAssignLicenseUseCase.execute,
                ).toHaveBeenCalledTimes(1);
                expect(
                    mockCodeBaseConfigService.getConfig,
                ).not.toHaveBeenCalled();
            },
        );

        it('falls back to the repository and global settings when the effective config cannot be resolved', async () => {
            unlicensed();
            mockPullRequestManagerService.getChangedFilesMetadata.mockRejectedValue(
                new Error('provider down'),
            );
            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    configs: { automatedReviewActive: true },
                    repositories: [
                        {
                            id: 'repo-1',
                            configs: { automatedReviewActive: false },
                        },
                    ],
                },
            });

            const result = await stage.execute(makeContext());

            expect(
                mockAutoAssignLicenseUseCase.execute,
            ).not.toHaveBeenCalled();
            expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
        });

        it('does not resolve the config when the author already holds a seat', async () => {
            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                { allowed: true },
            );

            await stage.execute(makeContext());

            expect(mockCodeBaseConfigService.getConfig).not.toHaveBeenCalled();
        });
    });

    describe('no-license notice', () => {
        const failNoSeat = (reason = 'NO_AVAILABLE_LICENSES') => {
            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.USER_NOT_LICENSED,
                },
            );
            mockAutoAssignLicenseUseCase.execute.mockResolvedValue({
                shouldProceed: false,
                reason,
            });
            mockParametersService.findByKey.mockResolvedValue(undefined);
        };

        it('reacts and posts the notice on the first skip, recording when', async () => {
            failNoSeat();
            mockCodeManagementService.createIssueComment.mockResolvedValue({
                id: 1,
            });

            const result = await stage.execute(makeContext());

            expect(
                mockCodeManagementService.addReactionToPR,
            ).toHaveBeenCalled();
            expect(
                mockAutomationExecutionService.hasPullRequestExecutionWithDataKey,
            ).toHaveBeenCalledWith({
                teamAutomationId: 'automation-1',
                repositoryId: 'repo-1',
                pullRequestNumber: 42,
                key: 'licenseNoticePostedAt',
            });
            expect(
                mockCodeManagementService.createIssueComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: 42,
                    body: licenseNoticeBody(PlatformType.GITHUB),
                }),
            );
            expect(result.statusInfo?.status).toBe(AutomationStatus.SKIPPED);
            expect(result.licenseNoticePostedAt).toEqual(expect.any(String));
        });

        it('posts the notice on the first skip only, keeping the reaction on later runs', async () => {
            failNoSeat();
            mockCodeManagementService.createIssueComment.mockResolvedValue({
                id: 1,
            });

            const first = await stage.execute(makeContext());
            expect(first.licenseNoticePostedAt).toEqual(expect.any(String));

            // The next run finds the notice the first one persisted.
            mockAutomationExecutionService.hasPullRequestExecutionWithDataKey.mockResolvedValue(
                true,
            );
            const second = await stage.execute(makeContext());

            expect(
                mockCodeManagementService.createIssueComment,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockCodeManagementService.addReactionToPR,
            ).toHaveBeenCalledTimes(2);
            expect(second.licenseNoticePostedAt).toBeUndefined();
        });

        it.each([PlatformType.AZURE_REPOS, PlatformType.BITBUCKET])(
            'posts only the notice on %s, without the old reaction comment',
            async (platformType) => {
                failNoSeat();
                mockCodeManagementService.createIssueComment.mockResolvedValue({
                    id: 1,
                });

                await stage.execute(makeContext({ platformType }));

                expect(
                    mockCodeManagementService.createIssueComment,
                ).toHaveBeenCalledTimes(1);
                expect(
                    mockCodeManagementService.createIssueComment,
                ).toHaveBeenCalledWith(
                    expect.objectContaining({
                        body: licenseNoticeBody(platformType),
                    }),
                );
                expect(
                    mockCodeManagementService.addReactionToPR,
                ).not.toHaveBeenCalled();
            },
        );

        it('answers a Bitbucket command in its thread', async () => {
            failNoSeat();
            mockCodeManagementService.createResponseToComment.mockResolvedValue(
                { id: 2 },
            );

            const result = await stage.execute(
                makeContext({
                    platformType: PlatformType.BITBUCKET,
                    triggerCommentId: '77',
                    origin: 'command',
                }),
            );

            expect(
                mockCodeManagementService.createResponseToComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    inReplyToId: 77,
                    body: licenseNoticeBody(PlatformType.BITBUCKET),
                }),
            );
            expect(
                mockCodeManagementService.createIssueComment,
            ).not.toHaveBeenCalled();
            expect(result.licenseNoticePostedAt).toEqual(expect.any(String));
        });

        it('does not record the notice when the provider did not post it', async () => {
            failNoSeat();
            mockCodeManagementService.createIssueComment.mockResolvedValue(
                null,
            );

            const result = await stage.execute(makeContext());

            expect(
                mockCodeManagementService.createIssueComment,
            ).toHaveBeenCalled();
            expect(result.licenseNoticePostedAt).toBeUndefined();
        });

        it('still posts the notice when the earlier-notice lookup fails', async () => {
            failNoSeat();
            mockAutomationExecutionService.hasPullRequestExecutionWithDataKey.mockRejectedValue(
                new Error('db down'),
            );
            mockCodeManagementService.createIssueComment.mockResolvedValue({
                id: 1,
            });

            const result = await stage.execute(makeContext());

            expect(
                mockCodeManagementService.createIssueComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: licenseNoticeBody(PlatformType.GITHUB),
                }),
            );
            expect(result.licenseNoticePostedAt).toEqual(expect.any(String));
        });

        it.each(['IGNORED_USER', 'NOT_ALLOWED_USER'])(
            'stays silent for a %s author',
            async (reason) => {
                failNoSeat(reason);

                const result = await stage.execute(makeContext());

                expect(
                    mockCodeManagementService.addReactionToPR,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.createIssueComment,
                ).not.toHaveBeenCalled();
                expect(result.licenseNoticePostedAt).toBeUndefined();
            },
        );

        it('posts nothing when auto-assign gives the author a seat', async () => {
            mockPermissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.USER_NOT_LICENSED,
                },
            );
            mockAutoAssignLicenseUseCase.execute.mockResolvedValue({
                shouldProceed: true,
                reason: 'ASSIGNED',
            });

            const result = await stage.execute(makeContext());

            expect(
                mockCodeManagementService.createIssueComment,
            ).not.toHaveBeenCalled();
            expect(
                mockCodeManagementService.addReactionToPR,
            ).not.toHaveBeenCalled();
            expect(result.statusInfo?.status).not.toBe(
                AutomationStatus.SKIPPED,
            );
            expect(result.licenseNoticePostedAt).toBeUndefined();
        });

        it('marks the notice with the HTML comment off Bitbucket and the chip on it', () => {
            for (const platformType of [
                PlatformType.GITHUB,
                PlatformType.GITLAB,
                PlatformType.AZURE_REPOS,
                PlatformType.FORGEJO,
            ]) {
                const body = licenseNoticeBody(platformType);
                expect(body.endsWith('<!-- kody-codereview -->')).toBe(true);
                expect(isKodyAuthoredBody(body)).toBe(true);
            }

            const bitbucket = licenseNoticeBody(PlatformType.BITBUCKET);
            expect(bitbucket.startsWith('`kody|code-review`\n\n## ')).toBe(
                true,
            );
            expect(bitbucket).not.toContain('<!--');
            expect(isKodyAuthoredBody(bitbucket)).toBe(true);
        });

        describe('showStatusFeedback in kodus-config.yml', () => {
            const storedConfig = (
                showStatusFeedback: boolean,
                fileOverridesWeb: boolean | undefined,
            ) =>
                mockParametersService.findByKey.mockResolvedValue({
                    configValue: {
                        configs: { showStatusFeedback },
                        repositories: [
                            {
                                id: 'repo-1',
                                configs:
                                    fileOverridesWeb === undefined
                                        ? {}
                                        : {
                                              kodusConfigFileOverridesWebPreferences:
                                                  fileOverridesWeb,
                                          },
                            },
                        ],
                    },
                });

            it('silences the reaction and the notice when the file turns it off', async () => {
                failNoSeat();
                storedConfig(true, true);
                mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue({
                    showStatusFeedback: false,
                });

                const result = await stage.execute(makeContext());

                expect(
                    mockCodeBaseConfigService.getKodusConfigFile,
                ).toHaveBeenCalledWith(
                    expect.objectContaining({
                        repository: { id: 'repo-1', name: 'repo-1' },
                        overrideConfig: true,
                        tolerateReviewSettingsErrors: true,
                    }),
                );
                expect(
                    mockCodeManagementService.addReactionToPR,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.createIssueComment,
                ).not.toHaveBeenCalled();
                expect(result.statusInfo?.status).toBe(
                    AutomationStatus.SKIPPED,
                );
                expect(result.pipelineMetadata?.showStatusFeedback).toBe(false);
                expect(result.licenseNoticePostedAt).toBeUndefined();
            });

            it('posts when the file turns it on over web settings that have it off', async () => {
                failNoSeat();
                storedConfig(false, true);
                mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue({
                    showStatusFeedback: true,
                });
                mockCodeManagementService.createIssueComment.mockResolvedValue({
                    id: 1,
                });

                const result = await stage.execute(makeContext());

                expect(
                    mockCodeManagementService.addReactionToPR,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.createIssueComment,
                ).toHaveBeenCalledTimes(1);
                expect(result.pipelineMetadata?.showStatusFeedback).toBe(true);
                expect(result.licenseNoticePostedAt).toEqual(
                    expect.any(String),
                );
            });

            it.each([false, undefined])(
                'leaves the web settings in charge when the repository has the file override %s',
                async (fileOverridesWeb) => {
                    failNoSeat();
                    storedConfig(true, fileOverridesWeb);
                    mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue(
                        { showStatusFeedback: false },
                    );
                    mockCodeManagementService.createIssueComment.mockResolvedValue(
                        { id: 1 },
                    );

                    await stage.execute(makeContext());

                    expect(
                        mockCodeBaseConfigService.getKodusConfigFile,
                    ).not.toHaveBeenCalled();
                    expect(
                        mockCodeManagementService.createIssueComment,
                    ).toHaveBeenCalledTimes(1);
                },
            );

            it('leaves the web settings in charge when the file has no value or cannot be read', async () => {
                failNoSeat();
                storedConfig(true, true);
                mockCodeManagementService.createIssueComment.mockResolvedValue({
                    id: 1,
                });

                mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValueOnce(
                    { ignorePaths: [] },
                );
                await stage.execute(makeContext());

                mockCodeBaseConfigService.getKodusConfigFile.mockRejectedValueOnce(
                    new Error('provider down'),
                );
                await stage.execute(makeContext());

                expect(
                    mockCodeManagementService.createIssueComment,
                ).toHaveBeenCalledTimes(2);
            });

            it.each(['IGNORED_USER', 'NOT_ALLOWED_USER'])(
                'does not read the file for a %s author',
                async (reason) => {
                    failNoSeat(reason);
                    storedConfig(true, true);

                    await stage.execute(makeContext());

                    expect(
                        mockCodeBaseConfigService.getKodusConfigFile,
                    ).not.toHaveBeenCalled();
                },
            );
        });
    });
});
