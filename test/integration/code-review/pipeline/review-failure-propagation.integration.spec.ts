/**
 * Integration test for the seam that decides what a user sees when the review
 * could not actually run: real PipelineExecutor + real stages + real observer,
 * with only the LLM provider and the git platform mocked.
 *
 * The invariant: a review that did not complete must never end as an approval
 * or a green check. Each stage in this chain returns rather than throws (so the
 * executor's own error path never fires), which means the whole signal travels
 * through `context.errors` — a fragile, easy-to-break contract that the unit
 * specs can only test one link at a time. A provider outage once travelled the
 * entire chain and came out as "Success, 0 findings" with the PR auto-approved.
 */
import { Test, TestingModule } from '@nestjs/testing';

import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { REPOSITORY_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { GraphContextService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-context.service';
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import { CodeReviewPipelineObserver } from '@libs/code-review/infrastructure/observers/code-review-pipeline.observer';
import { AgentReviewStage } from '@libs/code-review/pipeline/stages/agent-review.stage';
import { UpdateCommentsAndGenerateSummaryStage } from '@libs/code-review/pipeline/stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from '@libs/code-review/pipeline/stages/finish-process-review.stage';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { CodeReviewVersion } from '@libs/core/domain/enums/code-review.enum';
import { PlatformType } from '@libs/core/domain/enums';
import { CheckConclusion } from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { PIPELINE_CHECKS_SERVICE_TOKEN } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-checks-service.interface';
import { PipelineExecutor } from '@libs/core/infrastructure/pipeline/services/pipeline-executor.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { FeatureGateService } from '@libs/feature-gate';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { ORGANIZATION_SERVICE_TOKEN } from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

jest.mock('@libs/llm/llm-call', () => ({
    ...jest.requireActual('@libs/llm/llm-call'),
    tracedGenerateText: jest.fn(),
}));

jest.mock('@libs/llm/byok-to-vercel', () => ({
    withStructuredOutputFallback: jest.fn(),
    NoStructuredFallbackModelError: class extends Error {},
    getModelName: jest.fn().mockReturnValue('test-model'),
    getInternalModel: jest.fn().mockReturnValue({ __mockModel: 'internal' }),
    byokToVercelModel: jest.fn().mockReturnValue({ __mockModel: 'byok' }),
}));

jest.mock('ai', () => ({
    generateText: jest.fn(),
    Output: { object: jest.fn().mockReturnValue({}) },
    jsonSchema: jest.fn().mockReturnValue({}),
    stepCountIs: () => () => false,
    hasToolCall: () => () => false,
    tool: (opts: any) => opts,
}));

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

/** The failure from the field report: Fireworks base URL missing its /v1. */
const providerOutage = () =>
    Object.assign(new Error('Path not found: /chat/completions'), {
        name: 'AI_APICallError',
        statusCode: 404,
        isRetryable: false,
    });

describe('review failure propagation (agent → summary → approve → check)', () => {
    let executor: PipelineExecutor<any>;
    let observer: CodeReviewPipelineObserver;
    let stages: any[];

    let orchestrator: { execute: jest.Mock };
    let commentManager: Record<string, jest.Mock>;
    let codeManagement: Record<string, jest.Mock>;
    let checksService: { startCheck: jest.Mock; finalizeCheck: jest.Mock };

    const context = () => ({
        statusInfo: { status: AutomationStatus.IN_PROGRESS },
        pipelineVersion: 'test',
        errors: [],
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'api', fullName: 'acme/api' },
        branch: 'main',
        pullRequest: {
            number: 42,
            title: 'One-line change',
            url: 'https://github.com/acme/api/pull/42',
            user: { email: 'alex@acme.com', username: 'alex' },
            base: { repo: { fullName: 'acme/api' }, ref: 'main' },
            repository: {},
            isDraft: false,
            stats: {
                total_additions: 1,
                total_deletions: 0,
                total_files: 1,
                total_lines_changed: 1,
            },
        },
        changedFiles: [{ filename: 'src/index.ts', patch: '+x' }],
        lineComments: [],
        initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
        platformType: PlatformType.GITHUB,
        correlationId: 'corr-1',
        preparedFileContexts: [],
        validSuggestions: [],
        discardedSuggestions: [],
        codeReviewConfig: {
            codeReviewVersion: CodeReviewVersion.V3_AGENT,
            reviewOptions: { bug: true, security: true, performance: true },
            summary: { generatePRSummary: true },
            pullRequestApprovalActive: true,
            isRequestChangesActive: false,
            languageResultPrompt: 'en-US',
        },
    });

    const run = () =>
        executor.execute(context(), stages, 'CodeReviewPipeline', undefined, undefined, [
            observer,
        ]);

    beforeEach(async () => {
        orchestrator = { execute: jest.fn() };

        commentManager = {
            generateSummaryPR: jest.fn().mockResolvedValue('a summary'),
            updateSummarizationInPR: jest.fn().mockResolvedValue(undefined),
            updateOverallComment: jest.fn().mockResolvedValue(undefined),
            createComment: jest.fn().mockResolvedValue(undefined),
            processEndReviewMessageTemplate: jest.fn().mockResolvedValue(''),
        };

        codeManagement = {
            approvePullRequest: jest.fn().mockResolvedValue(undefined),
            getReviewStatusByPullRequest: jest
                .fn()
                .mockResolvedValue(PullRequestReviewState.PENDING),
            requestChangesPullRequest: jest.fn().mockResolvedValue(undefined),
        };

        checksService = {
            startCheck: jest.fn().mockResolvedValue(undefined),
            finalizeCheck: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AgentReviewStage,
                UpdateCommentsAndGenerateSummaryStage,
                RequestChangesOrApproveStage,
                CodeReviewPipelineObserver,
                { provide: ReviewOrchestratorService, useValue: orchestrator },
                {
                    provide: COMMENT_MANAGER_SERVICE_TOKEN,
                    useValue: commentManager,
                },
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: { getChangedFilesMetadata: jest.fn() },
                },
                { provide: CodeManagementService, useValue: codeManagement },
                {
                    provide: PIPELINE_CHECKS_SERVICE_TOKEN,
                    useValue: checksService,
                },
                {
                    provide: NotificationService,
                    useValue: { emit: jest.fn().mockResolvedValue(undefined) },
                },
                {
                    provide: PrAuthorRecipientResolver,
                    useValue: { resolve: jest.fn().mockResolvedValue(null) },
                },
                {
                    provide: ObservabilityService,
                    useValue: {
                        runInSpan: jest.fn((_n: string, fn: any) => fn()),
                        recordAgentRunUsage: jest.fn(),
                    },
                },
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: {
                        updateCodeReview: jest.fn().mockResolvedValue({
                            execution: { uuid: 'exec-1' },
                            stageLog: { uuid: 'log-1' },
                        }),
                        updateStageLog: jest.fn().mockResolvedValue(undefined),
                        findLatestStageLog: jest.fn().mockResolvedValue(null),
                        findById: jest.fn().mockResolvedValue(null),
                        update: jest.fn().mockResolvedValue(undefined),
                    },
                },
                {
                    provide: GraphContextService,
                    useValue: {
                        generateContext: jest.fn().mockResolvedValue(''),
                        generateContextLegacy: jest.fn().mockResolvedValue(''),
                    },
                },
                {
                    provide: REPOSITORY_SERVICE_TOKEN,
                    useValue: {
                        findOrCreate: jest.fn(),
                        findByExternalId: jest.fn(),
                        updateStatus: jest.fn(),
                    },
                },
                {
                    provide: FeatureGateService,
                    useValue: { isEnabled: jest.fn().mockResolvedValue(false) },
                },
                {
                    provide: ORGANIZATION_SERVICE_TOKEN,
                    useValue: {
                        getReleaseTrack: jest.fn().mockResolvedValue('beta'),
                    },
                },
            ],
        }).compile();

        executor = new PipelineExecutor();
        observer = module.get(CodeReviewPipelineObserver);
        stages = [
            module.get(AgentReviewStage),
            module.get(UpdateCommentsAndGenerateSummaryStage),
            module.get(RequestChangesOrApproveStage),
        ];
    });

    const finalConclusion = () =>
        checksService.finalizeCheck.mock.calls.at(-1)?.[2];

    describe('when the review agent cannot reach the provider', () => {
        beforeEach(() => {
            orchestrator.execute.mockRejectedValue(providerOutage());
        });

        it('does not approve the pull request', async () => {
            await run();

            expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        });

        it('publishes a FAILURE check, not a green one', async () => {
            await run();

            expect(finalConclusion()).toBe(CheckConclusion.FAILURE);
        });

        it('tells the PR comment the review failed, and why', async () => {
            await run();

            // updateOverallComment(..., reviewFailed, reviewErrorMessage, ...).
            // The message is the CLASSIFIED one, not the raw provider string —
            // a 404 on /chat/completions means "your model/base URL is wrong",
            // which is the actionable thing to put in front of the user.
            const args = commentManager.updateOverallComment.mock.calls[0];
            expect(args[11]).toBe(true);
            expect(args[12]).toMatch(/model/i);
        });
    });

    describe('when a core agent reports a failure', () => {
        beforeEach(() => {
            orchestrator.execute.mockResolvedValue({
                suggestions: [],
                agentResults: [],
                failures: [
                    {
                        agentName: 'generalist',
                        category: 'generalist',
                        error: providerOutage(),
                        durationMs: 6000,
                    },
                ],
                incomplete: [],
                totalDurationMs: 7000,
                warnings: [],
            });
        });

        it('does not read "zero findings" as "clean"', async () => {
            await run();

            expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
            expect(finalConclusion()).toBe(CheckConclusion.FAILURE);
        });
    });

    describe('when a core agent runs out of budget', () => {
        beforeEach(() => {
            orchestrator.execute.mockResolvedValue({
                suggestions: [],
                agentResults: [],
                failures: [],
                incomplete: [
                    {
                        agentName: 'generalist',
                        category: 'generalist',
                        finishReason: 'timeout',
                        suggestionsFound: 0,
                        durationMs: 1_800_000,
                    },
                ],
                totalDurationMs: 1_800_000,
                warnings: [],
            });
        });

        it('holds back the approval and marks the check NEUTRAL', async () => {
            await run();

            expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
            expect(finalConclusion()).toBe(CheckConclusion.NEUTRAL);
        });
    });

    describe('when only the summary provider fails', () => {
        beforeEach(() => {
            orchestrator.execute.mockResolvedValue({
                suggestions: [],
                agentResults: [],
                failures: [],
                incomplete: [],
                totalDurationMs: 1000,
                warnings: [],
            });
            commentManager.generateSummaryPR.mockRejectedValue(
                providerOutage(),
            );
        });

        it('holds back the approval and marks the check NEUTRAL', async () => {
            await run();

            expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
            expect(finalConclusion()).toBe(CheckConclusion.NEUTRAL);
        });
    });

    describe('when the review genuinely finds nothing', () => {
        beforeEach(() => {
            orchestrator.execute.mockResolvedValue({
                suggestions: [],
                agentResults: [],
                failures: [],
                incomplete: [],
                totalDurationMs: 120_000,
                warnings: [],
            });
        });

        it('still approves and publishes SUCCESS', async () => {
            await run();

            expect(codeManagement.approvePullRequest).toHaveBeenCalledTimes(1);
            expect(finalConclusion()).toBe(CheckConclusion.SUCCESS);
        });
    });
});
