import { IssueSource } from '@libs/issues/domain/interfaces/issues.interface';
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

    describe('mergeSuggestionsIntoIssues', () => {
        beforeEach(() => {
            // The stored PR's author differs from the webhook context's, so
            // only the lookup can supply it.
            pullRequestsServiceMock.findByNumberAndRepositoryName = jest
                .fn()
                .mockResolvedValue({
                    number: 42,
                    user: { id: 'stored-7', name: 'stored-author' },
                });
            issuesServiceMock.addContributingSuggestions = jest.fn();
            kodyIssuesAnalysisServiceMock.mergeSuggestionsIntoIssues =
                jest.fn();
        });

        it('stores a matched suggestion on the issue it matched', async () => {
            issuesServiceMock.findByFileAndStatus = jest
                .fn()
                .mockResolvedValue([
                    {
                        uuid: 'issue-1',
                        contributingSuggestions: [
                            { id: 'old', prNumber: 'not-a-number' },
                        ],
                    },
                ]);
            kodyIssuesAnalysisServiceMock.mergeSuggestionsIntoIssues.mockResolvedValue(
                {
                    matches: [
                        {
                            suggestionId: 'suggestion-1',
                            existingIssueId: 'issue-1',
                        },
                    ],
                },
            );

            await service.mergeSuggestionsIntoIssues(
                baseParams,
                'src/main.ts',
                [mockSuggestion],
                undefined,
            );

            expect(
                issuesServiceMock.addContributingSuggestions,
            ).toHaveBeenCalledWith(
                'issue-1',
                [
                    {
                        id: 'suggestion-1',
                        prNumber: 42,
                        prAuthor: { id: 'stored-7', name: 'stored-author' },
                    },
                ],
                'org-uuid',
            );
            expect(
                pullRequestsServiceMock.findByNumberAndRepositoryName,
            ).toHaveBeenCalledWith(
                42,
                'test-repo',
                mockOrganizationAndTeamData,
            );
            expect(issuesServiceMock.create).not.toHaveBeenCalled();
        });

        it('treats an issue id the model was not shown as no match', async () => {
            issuesServiceMock.findByFileAndStatus = jest
                .fn()
                .mockResolvedValue([
                    { uuid: 'issue-1', contributingSuggestions: [] },
                ]);
            kodyIssuesAnalysisServiceMock.mergeSuggestionsIntoIssues.mockResolvedValue(
                {
                    matches: [
                        {
                            suggestionId: 'suggestion-1',
                            existingIssueId: 'issue-of-another-tenant',
                        },
                    ],
                },
            );
            const createNewIssues = jest
                .spyOn(service as any, 'createNewIssues')
                .mockResolvedValue(undefined);

            await service.mergeSuggestionsIntoIssues(
                baseParams,
                'src/main.ts',
                [mockSuggestion],
                undefined,
            );

            expect(
                issuesServiceMock.addContributingSuggestions,
            ).not.toHaveBeenCalled();
            expect(createNewIssues).toHaveBeenCalledWith(baseParams, [
                mockSuggestion,
            ]);
        });

        it('matches against a security-scan issue, which has no PR suggestion', async () => {
            issuesServiceMock.findByFileAndStatus = jest
                .fn()
                .mockResolvedValue([
                    {
                        uuid: 'scan-issue',
                        title: 'IDOR on order lookup',
                        description: 'Any user can read any order.',
                        filePath: 'src/main.ts',
                        language: 'typescript',
                        contributingSuggestions: [],
                        source: IssueSource.SECURITY_SCAN,
                        repository: { ...mockRepository },
                    },
                    // The same id and file on another platform: another repository.
                    {
                        uuid: 'other-platform',
                        title: 'IDOR on order lookup',
                        description: 'Any user can read any order.',
                        filePath: 'src/main.ts',
                        language: 'typescript',
                        contributingSuggestions: [],
                        source: IssueSource.SECURITY_SCAN,
                        repository: { ...mockRepository, platform: 'other-platform' },
                    },
                ]);
            kodyIssuesAnalysisServiceMock.mergeSuggestionsIntoIssues.mockResolvedValue(
                { matches: [] },
            );

            await service.mergeSuggestionsIntoIssues(
                baseParams,
                'src/main.ts',
                [mockSuggestion],
                undefined,
            );

            const promptData =
                kodyIssuesAnalysisServiceMock.mergeSuggestionsIntoIssues.mock
                    .calls[0][2];
            expect(promptData.existingIssues).toEqual([
                {
                    issueId: 'scan-issue',
                    representativeSuggestion: [
                        expect.objectContaining({
                            id: 'scan-issue',
                            oneSentenceSummary: 'IDOR on order lookup',
                            suggestionContent: 'Any user can read any order.',
                        }),
                    ],
                },
            ]);
        });
    });

    describe('resolveExistingIssues', () => {
        it('leaves scan findings to the next scan when a closed pull request removes their file', async () => {
            jest.spyOn(service as any, 'getChangedFiles').mockResolvedValue([]);
            issuesServiceMock.findByFileAndStatus = jest
                .fn()
                .mockResolvedValue([
                    { uuid: 'scan-1', source: 'security_scan' },
                    { uuid: 'review-1' },
                ]);
            issuesServiceMock.updateStatusByIds = jest
                .fn()
                .mockResolvedValue([]);

            await service.resolveExistingIssues(
                baseParams,
                [{ path: 'src/main.ts', status: 'removed', suggestions: [] }],
                undefined,
            );

            // The pull request may be closed without a merge, or merged into
            // another branch than the one the scan read.
            expect(issuesServiceMock.updateStatusByIds).toHaveBeenCalledTimes(1);
            expect(issuesServiceMock.updateStatusByIds).toHaveBeenCalledWith(
                ['review-1'],
                'dismissed',
            );
        });

        it('never asks the model whether a scan finding is still in the pull request', async () => {
            jest.spyOn(service as any, 'getChangedFiles').mockResolvedValue([]);
            issuesServiceMock.findByFileAndStatus = jest
                .fn()
                .mockResolvedValue([{ uuid: 'scan-1', source: 'security_scan' }]);
            const resolve = jest.fn();
            (service as any).kodyIssuesAnalysisService.resolveExistingIssues =
                resolve;

            await service.resolveExistingIssues(
                baseParams,
                [{ path: 'src/main.ts', status: 'modified', suggestions: [] }],
                undefined,
            );

            expect(resolve).not.toHaveBeenCalled();
        });
    });

    describe('buildFilter', () => {
        it('filters by label when the API asks for a category', async () => {
            const filter = await service.buildFilter({
                organizationId: 'org-uuid',
                category: 'security' as any,
            });

            expect(filter).toEqual({
                organizationId: 'org-uuid',
                label: 'security',
            });
        });
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
