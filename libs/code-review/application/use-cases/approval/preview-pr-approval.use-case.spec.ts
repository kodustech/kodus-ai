import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PreviewPrApprovalUseCase } from './preview-pr-approval.use-case';

describe(PreviewPrApprovalUseCase.name, () => {
    const input = {
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repositoryId: 'repo',
        prNumber: 42,
    };
    const policy = { id: 'docs', name: 'Docs', enabled: true };
    const prURL = 'https://github.com/acme/example/pull/42';
    const pullRequest = {
        prURL,
        head: { sha: 'head' },
        base: { sha: 'base' },
        changedFilesCount: 1,
    };
    const files = [{ filename: 'docs/changelog.mdx', status: 'modified' }];

    function setup(reviewedHeadSha = 'head') {
        const parameters = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [{ id: 'repo', name: 'example' }],
                },
            }),
        };
        const configs = {
            getDefaultBranch: jest.fn().mockResolvedValue('main'),
            getMergedCodeReviewConfigs: jest.fn().mockResolvedValue({
                approvalPolicies: [policy],
                approvalPolicySource: 'canonical',
                pullRequestApprovalActive: true,
                riskAssessmentActive: false,
            }),
        };
        const executions = {
            findPullRequestExecutionsByOrganizationAndTeam: jest
                .fn()
                .mockResolvedValue({
                    data: [
                        {
                            status: AutomationStatus.SUCCESS,
                            dataExecution: {
                                approvalDecision: {
                                    reviewedHeadSha,
                                    reviewedBaseSha: 'base',
                                },
                                approvalReviewSummary: {
                                    complete: true,
                                    lineFindings: 0,
                                    prFindings: 0,
                                },
                                lastAnalyzedCommit: { sha: reviewedHeadSha },
                            },
                        },
                    ],
                }),
        };
        const codeManagement = {
            getTypeIntegration: jest
                .fn()
                .mockResolvedValue(PlatformType.GITHUB),
            getPullRequest: jest.fn().mockResolvedValue(pullRequest),
            getFilesByPullRequestId: jest.fn().mockResolvedValue(files),
            getPullRequestReviewThreads: jest.fn(),
        };
        const evaluate = jest.fn().mockResolvedValue({
            decision: {
                kind: 'approve',
                reason: 'Policy matched.',
                matchedPolicy: policy,
            },
        });
        const pullRequests = {
            findPullRequestsWithDeliveredSuggestions: jest
                .fn()
                .mockResolvedValue([]),
        };
        const useCase = new PreviewPrApprovalUseCase(
            parameters as never,
            configs as never,
            executions as never,
            {} as never,
            codeManagement as never,
            {} as never,
            { evaluate } as never,
            pullRequests as never,
        );
        return { useCase, evaluate, executions, codeManagement, pullRequests };
    }

    it('uses only the matching recorded clean snapshot and delegates to the real policy service', async () => {
        const { useCase, evaluate, executions } = setup();
        const result = await useCase.execute(input);
        expect(result.decision).toMatchObject({
            kind: 'approve',
            matchedPolicy: { id: 'docs' },
        });
        expect(
            executions.findPullRequestExecutionsByOrganizationAndTeam,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: input.organizationAndTeamData,
                repositoryIds: ['repo'],
                automationType: AutomationType.AUTOMATION_CODE_REVIEW,
                take: 1,
            }),
        );
        expect(evaluate).toHaveBeenCalledWith(
            expect.objectContaining({
                reviewClean: true,
                fullPrFiles: files,
                config: expect.objectContaining({ approvalPolicies: [policy] }),
            }),
        );
    });

    it('holds a stale recorded review and evaluates draft policies only with the explicit assumption', async () => {
        const { useCase, evaluate } = setup('old');
        expect((await useCase.execute(input)).decision).toEqual({
            kind: 'hold',
            reason: 'The PR changed after its latest recorded review.',
        });
        expect(
            (await useCase.execute({ ...input, policies: [] })).decision,
        ).toMatchObject({ kind: 'hold' });
        expect(evaluate).not.toHaveBeenCalled();

        const result = await useCase.execute({
            ...input,
            policies: [],
            assumeClean: true,
        });
        expect(result.assumptions).toMatchObject({
            cleanReview: true,
            draftPolicies: true,
        });
        expect(evaluate).toHaveBeenCalledWith(
            expect.objectContaining({
                config: expect.objectContaining({ approvalPolicies: [] }),
            }),
        );
    });

    it.each([
        prURL,
        'https://github.com/previous-owner/previous-name/pull/42',
        'http://github.com/acme/example/pull/42',
    ])(
        'holds a clean-looking review when a finding stored at %s remains open',
        async (url) => {
            const { useCase, evaluate, pullRequests, codeManagement } = setup();
            pullRequests.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                [
                    {
                        repository: { id: 'repo' },
                        provider: 'github',
                        url,
                        suggestions: [{ comment: { id: 'finding-1' } }],
                    },
                ],
            );
            codeManagement.getPullRequestReviewThreads.mockResolvedValue([
                { id: 'finding-1', isResolved: false },
            ]);
            expect((await useCase.execute(input)).decision).toEqual({
                kind: 'hold',
                reason: 'Review findings remain unresolved.',
            });
            expect(evaluate).not.toHaveBeenCalled();
            codeManagement.getPullRequestReviewThreads.mockResolvedValueOnce(
                undefined,
            );
            expect((await useCase.execute(input)).decision.reason).toBe(
                'Review findings could not be verified.',
            );
            codeManagement.getPullRequestReviewThreads.mockResolvedValue([
                { id: 'finding-1', isResolved: true },
            ]);
            expect((await useCase.execute(input)).decision.kind).toBe(
                'approve',
            );
        },
    );

    it.each([
        { stored: undefined, live: prURL },
        { stored: 'invalid URL', live: prURL },
        { stored: prURL, live: undefined },
    ])(
        'holds when a matching candidate has an unreadable host (%o)',
        async ({ stored, live }) => {
            const { useCase, evaluate, codeManagement, pullRequests } = setup();
            codeManagement.getPullRequest.mockResolvedValue({
                ...pullRequest,
                prURL: live,
            });
            pullRequests.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                [
                    {
                        repository: { id: 'repo' },
                        provider: 'github',
                        url: stored,
                        suggestions: [{ comment: { id: 'finding-1' } }],
                    },
                ],
            );

            expect((await useCase.execute(input)).decision).toEqual({
                kind: 'hold',
                reason: 'Review findings could not be verified.',
            });
            expect(
                codeManagement.getPullRequestReviewThreads,
            ).not.toHaveBeenCalled();
            expect(evaluate).not.toHaveBeenCalled();
        },
    );

    it.each([
        { name: 'no suggestions', suggestions: [] },
        {
            name: 'a finding with no comment ID',
            suggestions: [{ comment: {} }],
        },
    ])(
        'holds a matching delivered record with $name after a clean review',
        async ({ suggestions }) => {
            const { useCase, evaluate, codeManagement, pullRequests } = setup();
            pullRequests.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                [
                    {
                        repository: { id: 'repo' },
                        provider: 'github',
                        url: prURL,
                        suggestions,
                    },
                ],
            );

            expect((await useCase.execute(input)).decision).toEqual({
                kind: 'hold',
                reason: 'Review findings could not be verified.',
            });
            expect(
                codeManagement.getPullRequestReviewThreads,
            ).not.toHaveBeenCalled();
            expect(evaluate).not.toHaveBeenCalled();
        },
    );

    it('excludes findings from colliding IDs on other platforms and hosts', async () => {
        const { useCase, codeManagement, pullRequests } = setup();
        pullRequests.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [
                {
                    repository: { id: 'repo' },
                    provider: 'gitlab',
                    url: prURL,
                    suggestions: [{ comment: { id: 'other-platform' } }],
                },
                {
                    repository: { id: 'repo' },
                    provider: 'github',
                    url: 'https://github.example/acme/example/pull/42',
                    suggestions: [{ comment: { id: 'other-host' } }],
                },
            ],
        );
        expect((await useCase.execute(input)).decision.kind).toBe('approve');
        expect(
            codeManagement.getPullRequestReviewThreads,
        ).not.toHaveBeenCalled();
    });

    it('holds when the provider returns an incomplete file list', async () => {
        const { useCase, evaluate, codeManagement } = setup();
        codeManagement.getFilesByPullRequestId.mockResolvedValue([]);
        expect(
            (await useCase.execute({ ...input, assumeClean: true })).decision
                .kind,
        ).toBe('hold');
        expect(evaluate).not.toHaveBeenCalled();
    });
});
