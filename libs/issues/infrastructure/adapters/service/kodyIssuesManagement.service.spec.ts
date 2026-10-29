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
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';

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
            path: 'src/main.ts',
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

    describe('createNewIssues — issue text', () => {
        it('describes the issue with the full explanation, not the short comment body', async () => {
            pullRequestsServiceMock.findByNumberAndRepositoryName = jest
                .fn()
                .mockResolvedValue({ number: 42, user: { id: 'user-1' } });
            issuesServiceMock.create.mockResolvedValue({ uuid: 'i-1' });

            await service.createNewIssues(
                {
                    organizationAndTeamData: mockOrganizationAndTeamData,
                    repository: mockRepository,
                    pullRequest: mockPullRequest,
                } as any,
                [
                    {
                        ...mockSuggestion,
                        suggestionContent: 'Short body.',
                        fullExplanation:
                            'obj can be undefined when the cache misses. Reading prop throws. Use optional chaining.',
                    } as any,
                ],
            );

            expect(issuesServiceMock.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Add null safety check',
                    description:
                        'obj can be undefined when the cache misses. Reading prop throws. Use optional chaining.',
                }),
            );
        });
    });

    // #2097: a finding the repeat check kept off the PR is stored not sent,
    // with the schema's default implementationStatus; the earlier comment
    // already tracks it, so it never becomes an issue.
    it('leaves a suggestion discarded as a repeat out of the issues', async () => {
        const valid = await (service as any).filterValidSuggestionsFromPrByStatus([
            {
                path: 'src/main.ts',
                suggestions: [
                    mockSuggestion,
                    {
                        ...mockSuggestion,
                        id: 'suggestion-repeat',
                        deliveryStatus: DeliveryStatus.NOT_SENT,
                        priorityStatus: PriorityStatus.DISCARDED_BY_REPEAT,
                    },
                ],
            },
        ]);

        expect(valid.map((s: { id: string }) => s.id)).toEqual(['suggestion-1']);
    });

    describe('processClosedPr', () => {
        let mergeSpy: jest.SpyInstance;

        beforeEach(() => {
            mergeSpy = jest
                .spyOn(service, 'mergeSuggestionsIntoIssues')
                .mockResolvedValue(undefined);
        });

        it.each([
            ['no config stored', null],
            [
                'config without a value',
                {
                    configKey: ParametersKey.ISSUE_CREATION_CONFIG,
                    configValue: undefined,
                },
            ],
            [
                'config set to true',
                {
                    configKey: ParametersKey.ISSUE_CREATION_CONFIG,
                    configValue: true,
                },
            ],
        ])('creates issues by default (%s)', async (_label, config) => {
            parametersServiceMock.findByKey.mockResolvedValue(config);

            await service.processClosedPr(baseParams);

            expect(parametersServiceMock.findByKey).toHaveBeenCalledWith(
                ParametersKey.ISSUE_CREATION_CONFIG,
                mockOrganizationAndTeamData,
            );
            expect(mergeSpy).toHaveBeenCalledWith(
                baseParams,
                'src/main.ts',
                [expect.objectContaining({ id: 'suggestion-1' })],
                null,
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

        it('skips issue creation but still marks the PR synced when the config is explicitly false', async () => {
            parametersServiceMock.findByKey.mockResolvedValue({
                configKey: ParametersKey.ISSUE_CREATION_CONFIG,
                configValue: false,
            });

            await service.processClosedPr(baseParams);

            expect(mergeSpy).not.toHaveBeenCalled();
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).toHaveBeenCalled();
        });

        // Before the fix processClosedPr passed undefined as userGitId, so
        // managed plans returned allowed:false and no issue was ever created.
        it('validates permissions against the PR author git id', async () => {
            parametersServiceMock.findByKey.mockResolvedValue(null);

            await service.processClosedPr(baseParams);

            expect(
                permissionValidationServiceMock.validateExecutionPermissions,
            ).toHaveBeenCalledWith(
                mockOrganizationAndTeamData,
                mockPullRequest.user.id.toString(),
                'KodyIssuesManagementService',
            );
        });

        it('does nothing when permission validation fails', async () => {
            permissionValidationServiceMock.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.INVALID_LICENSE,
                },
            );

            await service.processClosedPr(baseParams);

            expect(parametersServiceMock.findByKey).not.toHaveBeenCalled();
            expect(mergeSpy).not.toHaveBeenCalled();
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).not.toHaveBeenCalled();
        });
    });
});
