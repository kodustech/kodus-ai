import { Injectable, Inject } from '@nestjs/common';
import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import {
    IAutomationExecutionService,
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { createLogger } from '@kodus/flow';
import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '../domain/contracts/SuggestionService.contract';
import { CheckImplementationJobPayload } from '../domain/interfaces/check-implementation-job.interface';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '../domain/contracts/PullRequestManagerService.contract';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';

@Injectable()
export class ImplementationVerificationProcessor implements IJobProcessorService {
    private readonly logger = createLogger(
        ImplementationVerificationProcessor.name,
    );

    constructor(
        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestManagerService: IPullRequestManagerService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
    ) {}

    async process(jobId: string, signal?: AbortSignal): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        if (job.workflowType !== WorkflowType.CHECK_SUGGESTION_IMPLEMENTATION) {
            throw new Error(`Invalid workflow type ${job.workflowType}`);
        }

        if (signal?.aborted) {
            throw new Error(`Job ${jobId} aborted before start`);
        }

        try {
            // Race the entire verification work against the parent's
            // AbortSignal. The block contains several sequential GitHub
            // /platform calls — any of them can stall on a retry-after,
            // and without this race the worker slot stays held past the
            // router timeout. The inner IIFE keeps all original local
            // variables in scope without refactoring into a separate
            // private method.
            await raceWithAbortSignal((async () => {
            const payload =
                job.payload as unknown as CheckImplementationJobPayload;

            const savedPr = await this.pullRequestsService.findOne({
                'number': payload.pullRequestNumber,
                'repository.id': payload.repository.id,
            } as any);

            if (!savedPr) {
                this.logger.warn({
                    message: `Pull Request not found in DB for implementation check`,
                    context: ImplementationVerificationProcessor.name,
                    metadata: {
                        prNumber: payload.pullRequestNumber,
                        repositoryId: payload.repository.id,
                    },
                });

                await this.markCompleted(jobId, { reason: 'PR_NOT_FOUND' });
                return;
            }

            // Extract all suggestions that are SENT and NOT IMPLEMENTED
            const suggestionsToCheck: Partial<CodeSuggestion>[] = (
                savedPr.files || []
            )
                .flatMap((file) => file.suggestions || [])
                .filter(
                    (s) =>
                        s.deliveryStatus === DeliveryStatus.SENT &&
                        s.implementationStatus !==
                            ImplementationStatus.IMPLEMENTED,
                )
                .map((s) => ({
                    id: s.id,
                    relevantFile: s.relevantFile,
                    language: s.language,
                    existingCode: s.existingCode,
                    improvedCode: s.improvedCode,
                    label: s.label,
                    severity: s.severity,
                }));

            if (suggestionsToCheck.length === 0) {
                await this.markCompleted(jobId, { reason: 'NO_SUGGESTIONS' });
                return;
            }

            // 2. Fetch Pull Request Details from Platform (to get latest state)
            const platformPr =
                payload.payload?.pull_request ||
                payload.payload?.resource ||
                (await this.pullRequestManagerService.getPullRequestDetails(
                    payload.organizationAndTeamData,
                    {
                        name: payload.repository.name,
                        id: payload.repository.id,
                    },
                    payload.pullRequestNumber,
                ));

            const teamAutomations = await this.teamAutomationService.find({
                team: { uuid: payload.organizationAndTeamData.teamId },
                status: true,
            });

            const teamAutomation = teamAutomations?.find(
                (ta) =>
                    ta.automation?.automationType ===
                    AutomationType.AUTOMATION_CODE_REVIEW,
            );

            // Retrieve last analyzed commit from the last successful code review execution
            const lastExecution =
                await this.automationExecutionService.findLatestExecutionByFilters(
                    {
                        pullRequestNumber: payload.pullRequestNumber,
                        repositoryId: payload.repository.id,
                        status: AutomationStatus.SUCCESS,
                        teamAutomation: { uuid: teamAutomation?.uuid },
                    },
                );

            const lastAnalyzedCommit =
                lastExecution?.dataExecution?.lastAnalyzedCommit;

            platformPr.number = payload.pullRequestNumber;

            // 3. Fetch Changed Files (Diff)
            const changedFiles =
                await this.pullRequestManagerService.getChangedFiles(
                    payload.organizationAndTeamData,
                    {
                        name: payload.repository.name,
                        id: payload.repository.id,
                        project: { id: platformPr.repository?.project?.id },
                    },
                    platformPr,
                    [],
                    lastAnalyzedCommit,
                );

            // 4. Construct Code Patch
            const changedFilenames = new Set(
                changedFiles.map((f) => f.filename),
            );

            // Filter suggestions to check ONLY for files that changed
            const suggestionsToValidate = suggestionsToCheck.filter(
                (s) => s.relevantFile && changedFilenames.has(s.relevantFile),
            );

            if (suggestionsToValidate.length === 0) {
                await this.markCompleted(jobId, {
                    reason: 'NO_RELEVANT_CHANGES',
                });
                return;
            }

            // Concatenate all patches to form a full diff string
            const codePatch = changedFiles
                .filter((f) => f.patch)
                .map((f) => `File: ${f.filename}\n${f.patch}`)
                .join('\n\n');

            if (!codePatch) {
                this.logger.warn({
                    message: `No code patch found for PR #${payload.pullRequestNumber}`,
                    context: ImplementationVerificationProcessor.name,
                    metadata: {
                        prNumber: payload.pullRequestNumber,
                    },
                });
                await this.markCompleted(jobId, { reason: 'NO_PATCH' });
                return;
            }

            // 5. Verify Implementation
            await this.suggestionService.validateImplementedSuggestions(
                payload.organizationAndTeamData,
                codePatch,
                suggestionsToValidate,
                payload.pullRequestNumber,
            );

            await this.suggestionService.resolveImplementedSuggestionsOnPlatform(
                {
                    organizationAndTeamData: payload.organizationAndTeamData,
                    repository: {
                        id: payload.repository.id,
                        name: payload.repository.name,
                    },
                    prNumber: payload.pullRequestNumber,
                    platformType: payload.platformType,
                },
            );

            await this.markCompleted(jobId, {
                checkedCount: suggestionsToCheck.length,
            });
            })(), signal);
        } catch (error) {
            this.logger.error({
                message: `Failed to process implementation check for job ${jobId}`,
                error: error instanceof Error ? error : undefined,
                context: ImplementationVerificationProcessor.name,
                metadata: {
                    jobId,
                    workflowType: job.workflowType,
                },
            });

            await this.handleFailure(jobId, error);
            throw error;
        }
    }

    async handleFailure(jobId: string, error: Error): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: ErrorClassification.PERMANENT,
            lastError: error.message,
            failedAt: new Date(),
        });
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
            result: result,
        });
    }
}
