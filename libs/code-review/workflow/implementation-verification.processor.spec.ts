import { ImplementationVerificationProcessor } from './implementation-verification.processor';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
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
            { emit: jest.fn() } as any,
        );
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

    it('validates the stored suggestions against the commits pushed after the review', async () => {
        await processor.process('job-1');

        expect(
            suggestionService.validateImplementedSuggestions,
        ).toHaveBeenCalledWith(
            job.payload.organizationAndTeamData,
            'File: app/a.rb\n@@ -1 +1 @@',
            [expect.objectContaining({ id: 's-1' })],
            42,
        );
    });

    // No commit since the review: the check ends before any LLM call.
    it('stops without validating when nothing changed since the review', async () => {
        pullRequestManagerService.getChangedFiles.mockResolvedValue([]);

        await processor.process('job-1');

        expect(
            suggestionService.validateImplementedSuggestions,
        ).not.toHaveBeenCalled();
        expect(jobRepository.update).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({
                status: JobStatus.COMPLETED,
                result: { reason: 'NO_RELEVANT_CHANGES' },
            }),
        );
    });
});
