import { Test, TestingModule } from '@nestjs/testing';
import { KodyIssuesManagementService } from './kodyIssuesManagement.service';
import { ISSUES_SERVICE_TOKEN } from '@libs/issues/domain/contracts/issues.service.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { KODY_ISSUES_ANALYSIS_SERVICE_TOKEN } from '@libs/ee/codeBase/kodyIssuesAnalysis.service';
import { CacheService } from '@libs/core/cache/cache.service';
import {
    PermissionValidationService,
    ValidationErrorType,
} from '@libs/ee/shared/services/permissionValidation.service';
import { ParametersKey } from '@libs/core/domain/enums';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { contextToGenerateIssues } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';

describe('KodyIssuesManagementService', () => {
    let service: KodyIssuesManagementService;
    let parametersServiceMock: any;
    let permissionValidationServiceMock: any;
    let issuesServiceMock: any;
    let pullRequestsServiceMock: any;
    let pullRequestManagerServiceMock: any;
    let cacheServiceMock: any;
    let kodyIssuesAnalysisServiceMock: any;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-uuid',
        teamId: 'team-uuid',
    };

    const mockRepository = {
        id: 'repo-123',
        name: 'test-repo',
        full_name: 'org/test-repo',
        platform: PlatformType.GITLAB,
    };

    const mockPullRequest = {
        number: 42,
        title: 'Test PR',
        user: { id: 'user-1', name: 'test-user' },
    };

    const mockSuggestion = {
        id: 'suggestion-1',
        relevantFile: 'src/main.ts',
        suggestionContent: 'Fix null check',
        existingCode: 'const x = obj.prop;',
        improvedCode: 'const x = obj?.prop;',
        oneSentenceSummary: 'Add null safety check',
        label: 'code_quality',
        severity: 'medium',
        language: 'typescript',
        deliveryStatus: DeliveryStatus.SENT,
        implementationStatus: ImplementationStatus.NOT_IMPLEMENTED,
        startLine: 10,
        endLine: 10,
    };

    const mockPrFiles = [
        {
            filename: 'src/main.ts',
            suggestions: [mockSuggestion],
        },
    ];

    const baseParams: contextToGenerateIssues = {
        organizationAndTeamData: mockOrganizationAndTeamData,
        repository: mockRepository,
        pullRequest: mockPullRequest,
        prFiles: mockPrFiles,
    };

    beforeEach(async () => {
        parametersServiceMock = {
            findByKey: jest.fn(),
        };

        permissionValidationServiceMock = {
            validateExecutionPermissions: jest.fn().mockResolvedValue({
                allowed: true,
                byokConfig: null,
            }),
        };

        issuesServiceMock = {
            create: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
        };

        pullRequestsServiceMock = {
            updateSyncedWithIssuesFlag: jest.fn().mockResolvedValue(undefined),
        };

        pullRequestManagerServiceMock = {};

        cacheServiceMock = {
            del: jest.fn(),
        };

        kodyIssuesAnalysisServiceMock = {
            mergeOrCreateIssues: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KodyIssuesManagementService,
                {
                    provide: ISSUES_SERVICE_TOKEN,
                    useValue: issuesServiceMock,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: pullRequestsServiceMock,
                },
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: pullRequestManagerServiceMock,
                },
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: parametersServiceMock,
                },
                {
                    provide: KODY_ISSUES_ANALYSIS_SERVICE_TOKEN,
                    useValue: kodyIssuesAnalysisServiceMock,
                },
                {
                    provide: CacheService,
                    useValue: cacheServiceMock,
                },
                {
                    provide: PermissionValidationService,
                    useValue: permissionValidationServiceMock,
                },
            ],
        }).compile();

        service = module.get<KodyIssuesManagementService>(
            KodyIssuesManagementService,
        );
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('processClosedPr - issue_creation_config behavior', () => {
        it('should default to auto-create issues when config does not exist in database (returns null)', async () => {
            parametersServiceMock.findByKey.mockResolvedValue(null);

            await service.processClosedPr(baseParams);

            expect(parametersServiceMock.findByKey).toHaveBeenCalledWith(
                ParametersKey.ISSUE_CREATION_CONFIG,
                mockOrganizationAndTeamData,
            );
            // Should proceed with issue processing (not skip it)
            // The updateSyncedWithIssuesFlag is always called at the end of a successful flow
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).toHaveBeenCalledWith(
                mockPullRequest.number,
                mockRepository.id,
                mockOrganizationAndTeamData.organizationId,
                true,
            );
        });

        it('should default to auto-create issues when config exists but configValue is undefined', async () => {
            parametersServiceMock.findByKey.mockResolvedValue({
                configKey: ParametersKey.ISSUE_CREATION_CONFIG,
                configValue: undefined,
            });

            await service.processClosedPr(baseParams);

            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).toHaveBeenCalled();
        });

        it('should auto-create issues when configValue is true', async () => {
            parametersServiceMock.findByKey.mockResolvedValue({
                configKey: ParametersKey.ISSUE_CREATION_CONFIG,
                configValue: true,
            });

            await service.processClosedPr(baseParams);

            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).toHaveBeenCalled();
        });

        it('should skip issue creation when configValue is explicitly false', async () => {
            parametersServiceMock.findByKey.mockResolvedValue({
                configKey: ParametersKey.ISSUE_CREATION_CONFIG,
                configValue: false,
            });

            await service.processClosedPr(baseParams);

            // Should still call updateSyncedWithIssuesFlag (runs after the if/else)
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).toHaveBeenCalled();
            // But should NOT attempt to create any issues
            expect(issuesServiceMock.create).not.toHaveBeenCalled();
        });

        it('should not process when permission validation fails', async () => {
            permissionValidationServiceMock.validateExecutionPermissions.mockResolvedValue(
                { allowed: false },
            );

            await service.processClosedPr(baseParams);

            // Should not even reach the parameters check
            expect(parametersServiceMock.findByKey).not.toHaveBeenCalled();
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).not.toHaveBeenCalled();
        });
    });

    describe('processClosedPr - managed plan with no userGitId', () => {
        it('should pass userGitId from pullRequest to permission validation for managed plans', async () => {
            // Before the fix, processClosedPr passed undefined as userGitId,
            // causing managed plans to return allowed:false (NOT_ERROR).
            // After the fix, it extracts userGitId from params.pullRequest.user.id
            // so the permission validation can properly check the licensed user.
            permissionValidationServiceMock.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: true,
                    byokConfig: null,
                },
            );
            parametersServiceMock.findByKey.mockResolvedValue(null);

            await service.processClosedPr(baseParams);

            // Verify userGitId is extracted from pullRequest.user.id and passed to validation
            expect(
                permissionValidationServiceMock.validateExecutionPermissions,
            ).toHaveBeenCalledWith(
                mockOrganizationAndTeamData,
                mockPullRequest.user.id.toString(),
                'KodyIssuesManagementService',
            );

            // Should proceed with issue processing
            expect(parametersServiceMock.findByKey).toHaveBeenCalledWith(
                ParametersKey.ISSUE_CREATION_CONFIG,
                mockOrganizationAndTeamData,
            );
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).toHaveBeenCalledWith(
                mockPullRequest.number,
                mockRepository.id,
                mockOrganizationAndTeamData.organizationId,
                true,
            );
        });

        it('should still block when permission fails for a real error (e.g. invalid license)', async () => {
            permissionValidationServiceMock.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.INVALID_LICENSE,
                },
            );

            await service.processClosedPr(baseParams);

            expect(parametersServiceMock.findByKey).not.toHaveBeenCalled();
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).not.toHaveBeenCalled();
        });
    });
});
