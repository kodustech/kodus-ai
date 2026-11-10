import { Injectable, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import { createLogger } from '@libs/core/log/logger';
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
import { PR_EXECUTION_UPDATED_EVENT } from '@libs/automation/infrastructure/adapters/services/automationExecution.service';
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
        private readonly eventEmitter: EventEmitter2,
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

            const savedSuggestions = (savedPr.files || []).flatMap(
                (file) => file.suggestions || [],
            );

            // Skip the platform calls when nothing delivered is left to check.
            const suggestionsToCheck = savedSuggestions.filter(
                (s) =>
                    s.deliveryStatus === DeliveryStatus.SENT &&
                    s.implementationStatus !==
                        ImplementationStatus.IMPLEMENTED,
            );

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

            // null when the provider can't serve the PR (deleted, revoked
            // access) — nothing to verify against.
            if (!platformPr) {
                this.logger.warn({
                    message: `PR#${payload.pullRequestNumber} not available on the platform; implementation check did not run`,
                    context: ImplementationVerificationProcessor.name,
                    metadata: {
                        organizationAndTeamData:
                            payload.organizationAndTeamData,
                        prNumber: payload.pullRequestNumber,
                        repositoryId: payload.repository.id,
                        jobId,
                    },
                });
                await this.markCompleted(jobId, {
                    reason: 'PLATFORM_PR_NOT_FOUND',
                });
                return;
            }

            const teamAutomations = await this.teamAutomationService.find({
                team: { uuid: payload.organizationAndTeamData.teamId },
                status: true,
            });

            const teamAutomation = teamAutomations?.find(
                (ta) =>
                    ta.automation?.automationType ===
                    AutomationType.AUTOMATION_CODE_REVIEW,
            );

            // Retrieve last analyzed commit from the last code review that
            // posted its comments. PARTIAL_ERROR posts them too (only an
            // auxiliary stage failed), and its suggestions are the ones to check.
            const lastExecution =
                await this.automationExecutionService.findLatestExecutionByFilters(
                    {
                        pullRequestNumber: payload.pullRequestNumber,
                        repositoryId: payload.repository.id,
                        status: [
                            AutomationStatus.SUCCESS,
                            AutomationStatus.PARTIAL_ERROR,
                        ],
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
                    lastExecution?.dataExecution?.reviewedBaseBranch,
                );

            // 4. Verify Implementation
            const check =
                await this.suggestionService.checkImplementedSuggestions({
                    organizationAndTeamData: payload.organizationAndTeamData,
                    prNumber: payload.pullRequestNumber,
                    changedFiles,
                    savedSuggestions,
                });

            if (check.skipped) {
                await this.markCompleted(jobId, { reason: check.skipped });
                return;
            }

            const implementedSuggestions = check.persisted;

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

            // 6. Broadcast so the dashboard's facet counts (Needs attention /
            // Awaiting cards) refetch right after statuses are persisted. The
            // verification pass is what flips implementationStatus, but unlike
            // the review run it never touches an automation execution — so
            // without this emit the SSE stream wouldn't tell the frontend a
            // suggestion was resolved, and the card could stay stale. Emit only
            // when at least one status was actually persisted (the service
            // returns only the suggestions it actually persisted); a no-op
            // verification shouldn't churn the API.
            if (implementedSuggestions?.length) {
                try {
                    this.eventEmitter.emit(PR_EXECUTION_UPDATED_EVENT, {
                        organizationId:
                            payload.organizationAndTeamData?.organizationId,
                        executionUuid: undefined,
                        status: AutomationStatus.SUCCESS,
                        timestamp: new Date().toISOString(),
                    });
                } catch (error) {
                    // The statuses are already persisted — a failing listener
                    // must never fail the whole verification job.
                    this.logger.warn({
                        message: `Failed to broadcast execution update after verification for PR#${payload.pullRequestNumber}`,
                        context: ImplementationVerificationProcessor.name,
                        error,
                        metadata: {
                            organizationId:
                                payload.organizationAndTeamData?.organizationId,
                            prNumber: payload.pullRequestNumber,
                        },
                    });
                }
            }

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
