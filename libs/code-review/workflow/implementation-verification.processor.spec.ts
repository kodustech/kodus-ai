import { ImplementationVerificationProcessor } from './implementation-verification.processor';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';

const sentSuggestion = (id: string, relevantFile = 'app/a.rb') => ({
    id,
    relevantFile,
    deliveryStatus: DeliveryStatus.SENT,
    implementationStatus: ImplementationStatus.NOT_IMPLEMENTED,
});

describe('ImplementationVerificationProcessor', () => {
    let processor: ImplementationVerificationProcessor;
    let jobRepository: { findOne: jest.Mock; update: jest.Mock };
    let pullRequestsService: { findOne: jest.Mock };
    let pullRequestManagerService: {
        getPullRequestDetails: jest.Mock;
        getChangedFiles: jest.Mock;
    };
    let automationExecutionService: { findLatestExecutionByFilters: jest.Mock };
    let suggestionService: {
        validateImplementedSuggestions: jest.Mock;
        resolveImplementedSuggestionsOnPlatform: jest.Mock;
    };
    let eventEmitter: { emit: jest.Mock };

    const job = {
        id: 'job-1',
        workflowType: WorkflowType.CHECK_SUGGESTION_IMPLEMENTATION,
        payload: {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { id: 'repo-1', name: 'repo-name' },
            pullRequestNumber: 42,
            commitSha: 'reviewed-sha',
            trigger: 'review_completed',
            platformType: 'GITHUB',
        },
    };

    beforeEach(() => {
        jobRepository = {
            findOne: jest.fn().mockResolvedValue(job),
            update: jest.fn().mockResolvedValue(undefined),
        };
        pullRequestsService = {
            findOne: jest.fn().mockResolvedValue({
                files: [{ suggestions: [sentSuggestion('s-1')] }],
            }),
        };
        pullRequestManagerService = {
            getPullRequestDetails: jest
                .fn()
                .mockResolvedValue({ head: { sha: 'fix-sha' } }),
            getChangedFiles: jest
                .fn()
                .mockResolvedValue([
                    { filename: 'app/a.rb', patch: '@@ -1 +1 @@' },
                ]),
        };
        automationExecutionService = {
            findLatestExecutionByFilters: jest.fn().mockResolvedValue({
                dataExecution: { lastAnalyzedCommit: { sha: 'reviewed-sha' } },
            }),
        };
        suggestionService = {
            validateImplementedSuggestions: jest.fn().mockResolvedValue([]),
            resolveImplementedSuggestionsOnPlatform: jest
                .fn()
                .mockResolvedValue(undefined),
        };

        eventEmitter = { emit: jest.fn() };

        processor = new ImplementationVerificationProcessor(
            suggestionService as any,
            jobRepository as any,
            pullRequestsService as any,
            pullRequestManagerService as any,
            automationExecutionService as any,
            {
                find: jest.fn().mockResolvedValue([
                    {
                        uuid: 'team-automation-1',
                        automation: {
                            automationType:
                                AutomationType.AUTOMATION_CODE_REVIEW,
                        },
                    },
                ]),
            } as any,
            eventEmitter as any,
        );
    });

    const completedWith = (result: unknown) =>
        expect(jobRepository.update).toHaveBeenCalledWith('job-1', {
            status: JobStatus.COMPLETED,
            completedAt: expect.any(Date),
            result,
        });

    const savedSuggestions = (...suggestions: unknown[]) =>
        pullRequestsService.findOne.mockResolvedValue({
            files: [{ suggestions }],
        });

    // A review that ends PARTIAL_ERROR still posted its suggestions; its
    // reviewed commit is where the diff has to start (#2182).
    it('diffs from the last review that posted, SUCCESS or PARTIAL_ERROR', async () => {
        await processor.process('job-1');

        expect(
            automationExecutionService.findLatestExecutionByFilters,
        ).toHaveBeenCalledWith({
            pullRequestNumber: 42,
            repositoryId: 'repo-1',
            status: [AutomationStatus.SUCCESS, AutomationStatus.PARTIAL_ERROR],
            teamAutomation: { uuid: 'team-automation-1' },
        });
        expect(pullRequestManagerService.getChangedFiles).toHaveBeenCalledWith(
            job.payload.organizationAndTeamData,
            expect.anything(),
            expect.anything(),
            [],
            { sha: 'reviewed-sha' },
        );
    });

    it('validates against the new patch, resolves on the platform, completes and broadcasts', async () => {
        suggestionService.validateImplementedSuggestions.mockResolvedValue([
            { id: 's-1', implementationStatus: ImplementationStatus.IMPLEMENTED },
        ]);

        await processor.process('job-1');

        expect(
            suggestionService.validateImplementedSuggestions,
        ).toHaveBeenCalledWith(
            job.payload.organizationAndTeamData,
            'File: app/a.rb\n@@ -1 +1 @@',
            [expect.objectContaining({ id: 's-1' })],
            42,
        );
        expect(
            suggestionService.resolveImplementedSuggestionsOnPlatform,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: job.payload.organizationAndTeamData,
            repository: { id: 'repo-1', name: 'repo-name' },
            prNumber: 42,
            platformType: 'GITHUB',
        });
        expect(
            pullRequestManagerService.getPullRequestDetails,
        ).toHaveBeenCalledWith(
            job.payload.organizationAndTeamData,
            { name: 'repo-name', id: 'repo-1' },
            42,
        );
        completedWith({ checkedCount: 1 });
        // Tells the dashboard's "Needs attention" card to refetch.
        expect(eventEmitter.emit).toHaveBeenCalledWith(
            'pr-execution.updated',
            expect.objectContaining({
                organizationId: 'org-1',
                status: 'success',
            }),
        );
    });

    it('checks PARTIALLY_IMPLEMENTED suggestions and does not broadcast when nothing was persisted', async () => {
        savedSuggestions({
            ...sentSuggestion('partial'),
            implementationStatus: ImplementationStatus.PARTIALLY_IMPLEMENTED,
        });

        await processor.process('job-1');

        expect(
            suggestionService.validateImplementedSuggestions.mock.calls[0][2],
        ).toEqual([expect.objectContaining({ id: 'partial' })]);
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        // The count of checked suggestions, not of implemented ones.
        completedWith({ checkedCount: 1 });
    });

    it('hands the validator only the fields it needs, not the stored comment data', async () => {
        savedSuggestions({
            ...sentSuggestion('s-1'),
            language: 'ruby',
            existingCode: 'a = 1',
            improvedCode: 'a = 2',
            label: 'bug',
            severity: 'high',
            suggestionContent: 'Add type annotation',
            comment: { id: 123, pullRequestReviewId: 456 },
            rankScore: 100,
            priorityStatus: 'PRIORITIZED',
        });

        await processor.process('job-1');

        expect(
            suggestionService.validateImplementedSuggestions.mock.calls[0][2],
        ).toEqual([
            {
                id: 's-1',
                relevantFile: 'app/a.rb',
                language: 'ruby',
                existingCode: 'a = 1',
                improvedCode: 'a = 2',
                label: 'bug',
                severity: 'high',
            },
        ]);
    });

    it('still checks when the team has no code review automation', async () => {
        (processor as any).teamAutomationService.find.mockResolvedValue(null);

        await processor.process('job-1');

        completedWith({ checkedCount: 1 });
    });

    it('validates only suggestions on changed files, against all their patches', async () => {
        savedSuggestions(
            sentSuggestion('s-index', 'src/index.ts'),
            sentSuggestion('s-utils', 'src/utils.ts'),
            sentSuggestion('s-other', 'src/other.ts'),
        );
        pullRequestManagerService.getChangedFiles.mockResolvedValue([
            { filename: 'src/index.ts', patch: 'patch1' },
            { filename: 'src/utils.ts', patch: 'patch2' },
        ]);

        await processor.process('job-1');

        const [, codePatch, passed] =
            suggestionService.validateImplementedSuggestions.mock.calls[0];
        expect(passed.map((x: { id: string }) => x.id)).toEqual([
            's-index',
            's-utils',
        ]);
        expect(codePatch).toBe(
            'File: src/index.ts\npatch1\n\nFile: src/utils.ts\npatch2',
        );
    });

    it.each([
        {
            source: 'pull_request (webhook payload)',
            embedded: {
                pull_request: {
                    number: 99,
                    title: 'Test PR',
                    repository: { project: { id: 'project-xyz' } },
                },
            },
            projectId: 'project-xyz',
        },
        {
            source: 'resource (Azure DevOps)',
            embedded: {
                resource: {
                    pullRequestId: 42,
                    title: 'Azure PR',
                    repository: { project: { id: 'azure-project-id' } },
                },
            },
            projectId: 'azure-project-id',
        },
    ])(
        'uses the PR from the $source instead of fetching it',
        async ({ embedded, projectId }) => {
            jobRepository.findOne.mockResolvedValue({
                ...job,
                payload: { ...job.payload, payload: embedded },
            });

            await processor.process('job-1');

            expect(
                pullRequestManagerService.getPullRequestDetails,
            ).not.toHaveBeenCalled();
            const [, repositoryArg, platformPrArg] =
                pullRequestManagerService.getChangedFiles.mock.calls[0];
            expect(repositoryArg.project).toEqual({ id: projectId });
            // Overwritten by payload.pullRequestNumber.
            expect(platformPrArg.number).toBe(42);
        },
    );

    it('throws when the job does not exist', async () => {
        jobRepository.findOne.mockResolvedValue(null);

        await expect(processor.process('missing')).rejects.toThrow(
            'Job missing not found',
        );
    });

    it('rejects a job of another workflow type', async () => {
        jobRepository.findOne.mockResolvedValue({
            ...job,
            workflowType: 'AUTOMATION_EXECUTION',
        });

        await expect(processor.process('job-1')).rejects.toThrow(
            'Invalid workflow type AUTOMATION_EXECUTION',
        );
    });

    it('completes with PR_NOT_FOUND when the PR is not in the database', async () => {
        pullRequestsService.findOne.mockResolvedValue(null);

        await processor.process('job-1');

        completedWith({ reason: 'PR_NOT_FOUND' });
        expect(
            suggestionService.validateImplementedSuggestions,
        ).not.toHaveBeenCalled();
    });

    it.each([
        {
            scenario: 'already implemented',
            over: { implementationStatus: ImplementationStatus.IMPLEMENTED },
        },
        {
            scenario: 'not delivered',
            over: { deliveryStatus: DeliveryStatus.FAILED },
        },
    ])(
        'completes with NO_SUGGESTIONS when the only suggestion is $scenario',
        async ({ over }) => {
            savedSuggestions({ ...sentSuggestion('s-1'), ...over });

            await processor.process('job-1');

            completedWith({ reason: 'NO_SUGGESTIONS' });
            expect(
                suggestionService.validateImplementedSuggestions,
            ).not.toHaveBeenCalled();
        },
    );

    it.each([
        { scenario: 'no files', pr: { files: null } },
        { scenario: 'a file with no suggestions', pr: { files: [{ suggestions: null }] } },
    ])(
        'completes with NO_SUGGESTIONS for a saved PR with $scenario',
        async ({ pr }) => {
            pullRequestsService.findOne.mockResolvedValue(pr);

            await processor.process('job-1');

            completedWith({ reason: 'NO_SUGGESTIONS' });
        },
    );

    // No commit touched a suggested file since the review: the check ends
    // before any LLM call.
    it('completes with NO_RELEVANT_CHANGES when no suggested file changed', async () => {
        pullRequestManagerService.getChangedFiles.mockResolvedValue([
            { filename: 'src/unrelated.ts', patch: '@@ -1 +1 @@' },
        ]);

        await processor.process('job-1');

        completedWith({ reason: 'NO_RELEVANT_CHANGES' });
        expect(
            suggestionService.validateImplementedSuggestions,
        ).not.toHaveBeenCalled();
    });

    // getPullRequestDetails returns null when the provider can't serve the PR
    // (deleted, dead credentials); `platformPr.number = …` then threw
    // "Cannot set properties of null" and the job failed.
    it('completes with PLATFORM_PR_NOT_FOUND when the provider returns no PR', async () => {
        pullRequestManagerService.getPullRequestDetails.mockResolvedValue(null);
        const warn = jest
            .spyOn((processor as any).logger, 'warn')
            .mockImplementation(() => undefined);

        await processor.process('job-1');

        completedWith({ reason: 'PLATFORM_PR_NOT_FOUND' });
        expect(pullRequestManagerService.getChangedFiles).not.toHaveBeenCalled();
        // The skipped check stays traceable per org/PR.
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    prNumber: 42,
                    repositoryId: 'repo-1',
                }),
            }),
        );
    });

    it('completes with NO_PATCH when the changed files carry no patch', async () => {
        pullRequestManagerService.getChangedFiles.mockResolvedValue([
            { filename: 'app/a.rb', patch: null },
        ]);

        await processor.process('job-1');

        completedWith({ reason: 'NO_PATCH' });
    });

    it('marks the job failed and rethrows when validation throws', async () => {
        suggestionService.validateImplementedSuggestions.mockRejectedValue(
            new Error('Test error during validation'),
        );

        await expect(processor.process('job-1')).rejects.toThrow(
            'Test error during validation',
        );
        expect(jobRepository.update).toHaveBeenCalledWith('job-1', {
            status: JobStatus.FAILED,
            errorClassification: ErrorClassification.PERMANENT,
            lastError: 'Test error during validation',
            failedAt: expect.any(Date),
        });
    });

    // Several sequential platform calls, any of which can stall on a
    // retry-after; without the race the worker slot stayed held past the
    // router timeout.
    describe('AbortSignal', () => {
        it('unblocks when the signal fires mid-work', async () => {
            pullRequestsService.findOne.mockImplementation(
                () => new Promise(() => {}),
            );
            const controller = new AbortController();
            const work = processor.process('job-1', controller.signal);

            await new Promise((r) => setTimeout(r, 20));
            expect(pullRequestsService.findOne).toHaveBeenCalledTimes(1);

            controller.abort();

            await expect(work).rejects.toThrow('aborted');
        });

        it('does not start when the signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                processor.process('job-1', controller.signal),
            ).rejects.toThrow(/aborted before start/);
            expect(pullRequestsService.findOne).not.toHaveBeenCalled();
        });
    });
});
