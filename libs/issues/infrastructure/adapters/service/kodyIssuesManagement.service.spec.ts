import { LLM_TASK, type NormalizedModel } from '@libs/llm/byok-config';
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

jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false, API_DEVELOPMENT_MODE: false },
}));

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
            resolveTaskSlot: jest.fn().mockResolvedValue(undefined),
            hasBYOK: jest.fn().mockResolvedValue(false),
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
        const valid = await (
            service as any
        ).filterValidSuggestionsFromPrByStatus([
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

        expect(valid.map((s: { id: string }) => s.id)).toEqual([
            'suggestion-1',
        ]);
    });

    describe('processClosedPr', () => {
        let mergeSpy: jest.SpyInstance;

        beforeEach(() => {
            mergeSpy = jest
                .spyOn(service, 'mergeSuggestionsIntoIssues')
                .mockResolvedValue(undefined);
        });

        it('resolves the self-hosted slot and preserves fallback and limits in both consumers', async () => {
            const slot: NormalizedModel = {
                provider: 'openai_compatible',
                apiKey: 'test-placeholder',
                model: 'primary-model',
                maxInputTokens: 200000,
                maxConcurrentRequests: 2,
                fallback: {
                    provider: 'openrouter',
                    apiKey: 'test-placeholder',
                    model: 'fallback-model',
                },
            };
            permissionValidationServiceMock.validateExecutionPermissions.mockResolvedValue(
                { allowed: true },
            );
            permissionValidationServiceMock.resolveTaskSlot.mockResolvedValue(
                slot,
            );
            const resolveSpy = jest
                .spyOn(service as any, 'resolveExistingIssues')
                .mockResolvedValue(undefined);

            await service.processClosedPr(baseParams);

            expect(
                permissionValidationServiceMock.resolveTaskSlot,
            ).toHaveBeenCalledWith(
                mockOrganizationAndTeamData,
                LLM_TASK.codeReview,
            );
            expect(mergeSpy.mock.calls[0][3]).toBe(slot);
            expect(resolveSpy).toHaveBeenCalledWith(
                baseParams,
                mockPrFiles,
                slot,
            );
            expect(resolveSpy.mock.calls[0][2]).toBe(slot);
            expect(
                permissionValidationServiceMock.hasBYOK,
            ).not.toHaveBeenCalled();
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).toHaveBeenCalled();
        });

        it('keeps a carrier supplied by permission validation without resolving it again', async () => {
            const slot: NormalizedModel = {
                provider: 'openai',
                apiKey: 'test-placeholder',
                model: 'validated-model',
            };
            permissionValidationServiceMock.validateExecutionPermissions.mockResolvedValue(
                { allowed: true, byokConfig: slot },
            );
            const resolveSpy = jest
                .spyOn(service as any, 'resolveExistingIssues')
                .mockResolvedValue(undefined);

            await service.processClosedPr(baseParams);

            expect(mergeSpy.mock.calls[0][3]).toBe(slot);
            expect(resolveSpy.mock.calls[0][2]).toBe(slot);
            expect(
                permissionValidationServiceMock.resolveTaskSlot,
            ).not.toHaveBeenCalled();
            expect(
                permissionValidationServiceMock.hasBYOK,
            ).not.toHaveBeenCalled();
        });

        it('retains the managed default for an organization without BYOK', async () => {
            const resolveSpy = jest
                .spyOn(service as any, 'resolveExistingIssues')
                .mockResolvedValue(undefined);

            await service.processClosedPr(baseParams);

            expect(
                permissionValidationServiceMock.hasBYOK,
            ).toHaveBeenCalledWith(mockOrganizationAndTeamData);
            expect(mergeSpy.mock.calls[0][3]).toBeNull();
            expect(resolveSpy).toHaveBeenCalledWith(
                baseParams,
                mockPrFiles,
                null,
            );
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).toHaveBeenCalled();
        });

        it.each([
            'unresolved BYOK',
            'routing read failure',
            'BYOK read failure',
        ])(
            'leaves the PR unsynced without running issue analysis on %s',
            async (failure) => {
                permissionValidationServiceMock.hasBYOK.mockResolvedValue(true);
                if (failure === 'routing read failure') {
                    permissionValidationServiceMock.resolveTaskSlot.mockRejectedValue(
                        new Error('routing read unavailable'),
                    );
                } else if (failure === 'BYOK read failure') {
                    permissionValidationServiceMock.hasBYOK.mockRejectedValue(
                        new Error('BYOK read unavailable'),
                    );
                }
                const resolveSpy = jest
                    .spyOn(service as any, 'resolveExistingIssues')
                    .mockResolvedValue(undefined);
                const errorSpy = jest
                    .spyOn((service as any).logger, 'error')
                    .mockImplementation(() => {});

                await service.processClosedPr(baseParams);

                expect(mergeSpy).not.toHaveBeenCalled();
                expect(resolveSpy).not.toHaveBeenCalled();
                expect(parametersServiceMock.findByKey).not.toHaveBeenCalled();
                expect(
                    pullRequestsServiceMock.updateSyncedWithIssuesFlag,
                ).not.toHaveBeenCalled();
                expect(errorSpy).toHaveBeenCalled();
            },
        );

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

            expect(
                permissionValidationServiceMock.resolveTaskSlot,
            ).not.toHaveBeenCalled();
            expect(
                permissionValidationServiceMock.hasBYOK,
            ).not.toHaveBeenCalled();
            expect(parametersServiceMock.findByKey).not.toHaveBeenCalled();
            expect(mergeSpy).not.toHaveBeenCalled();
            expect(
                pullRequestsServiceMock.updateSyncedWithIssuesFlag,
            ).not.toHaveBeenCalled();
        });
    });
});
