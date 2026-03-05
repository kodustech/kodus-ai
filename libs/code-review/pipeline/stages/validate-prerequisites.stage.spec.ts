import { Test, TestingModule } from '@nestjs/testing';

import { PlatformType } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
    IOrganizationParametersService,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { AutoAssignLicenseUseCase } from '@libs/ee/license/use-cases/auto-assign-license.use-case';
import {
    PermissionValidationService,
    ValidationErrorType,
} from '@libs/ee/shared/services/permissionValidation.service';
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
            batches: [],
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
});
