import { Inject, Injectable, Optional } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    pullRequestSessionId,
    withLangfuseTrace,
} from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { LLM_TASK } from '@libs/llm/byok-config';
import type { MCPServerConfig } from '@libs/mcp-server/mcp-adapter';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { SkillLoaderService } from '../skills/skill-loader.service';
import type {
    BusinessValidationOutcome,
    BusinessValidationRequest,
    BusinessValidationResult,
    ResolutionAttempt,
    Task,
    TaskReference,
    TaskResolution,
} from './business-validation.types';
import { IntentJudge, JudgePolicy } from './judge/intent-judge';
import * as messages from './messages';
import { canJudgeAgainst, formatTaskForJudge, gradeTask } from './task-quality';
import { extractTaskReferences } from './task-references';
import { resolveTask } from './task-resolver';
import { buildTaskTrackers } from './trackers/tracker-catalog';

export const BUSINESS_VALIDATION_SKILL = 'business-rules-validation';
const DEFAULT_LANGUAGE = 'en-US';
/** Text passed to the command that names no task is the task itself, if it says this much. */
const MIN_INLINE_TASK = 40;

/**
 * The one way into business-logic validation, for the review pipeline, the
 * `@kody -v business-logic` command and the CLI alike:
 *
 *   references in the PR → the task a connected tracker confirms → the judge
 *
 * Each step that can't go on returns why, so a door decides what to post:
 * the automatic review posts only a verdict or a task too thin to judge, and
 * stays silent otherwise; a command always answers.
 */
@Injectable()
export class BusinessValidationService {
    private readonly logger = createLogger(BusinessValidationService.name);

    constructor(
        private readonly mcpManagerService: MCPManagerService,
        private readonly permissionValidationService: PermissionValidationService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly skillLoaderService: SkillLoaderService,
        @Optional() private readonly metricsCollector?: MetricsCollectorService,
        @Optional() private readonly byokErrorCounter?: ByokErrorCounter,
    ) {}

    async validate(
        request: BusinessValidationRequest,
    ): Promise<BusinessValidationResult> {
        const pullRequestId = request.pullRequest?.number;
        return withLangfuseTrace(
            {
                traceName: BUSINESS_VALIDATION_SKILL,
                userId: request.organizationAndTeamData.organizationId,
                sessionId: pullRequestSessionId({
                    organizationId:
                        request.organizationAndTeamData.organizationId,
                    repositoryId: request.repository?.id,
                    pullRequestId,
                }),
                metadata: {
                    organizationId:
                        request.organizationAndTeamData.organizationId,
                    teamId: request.organizationAndTeamData.teamId,
                    repositoryId: request.repository?.id,
                    pullRequestId:
                        pullRequestId !== undefined
                            ? String(pullRequestId)
                            : undefined,
                    door: request.door,
                },
            },
            () => this.run(request),
        );
    }

    private async run(
        request: BusinessValidationRequest,
    ): Promise<BusinessValidationResult> {
        const references = extractTaskReferences({
            command: request.taskInput,
            title: request.pullRequest?.title,
            branch: request.pullRequest?.headRef,
            body: request.pullRequest?.body,
        });
        const inlineTask = this.inlineTask(request.taskInput, references);

        let resolution: TaskResolution;
        let trackerNames: string[] = [];
        if (inlineTask) {
            resolution = { kind: 'found', task: inlineTask, attempts: [] };
        } else if (!references.length) {
            resolution = { kind: 'no_reference', attempts: [] };
        } else {
            const servers = await this.connections(
                request.organizationAndTeamData,
            );
            const trackers = buildTaskTrackers(servers);
            trackerNames = trackers.map((t) => t.name);
            try {
                resolution = await resolveTask(references, trackers, {
                    organizationAndTeamData: request.organizationAndTeamData,
                    repository: this.repositoryOf(request),
                });
            } finally {
                await Promise.all(trackers.map((t) => t.close()));
            }
        }

        const outcome = await this.decide(
            request,
            resolution,
            references,
            trackerNames,
        );
        this.record(request, outcome, references, resolution.attempts);
        return { outcome, references, attempts: resolution.attempts };
    }

    private async decide(
        request: BusinessValidationRequest,
        resolution: TaskResolution,
        references: TaskReference[],
        trackerNames: string[],
    ): Promise<BusinessValidationOutcome> {
        const language = await this.language(request.organizationAndTeamData);
        let judgeInstance: Promise<IntentJudge> | undefined;
        const judge = () => (judgeInstance ??= this.judge(request));
        const skip = async (
            reason: Extract<
                BusinessValidationOutcome,
                { kind: 'skipped' }
            >['reason'],
            message: string,
        ): Promise<BusinessValidationOutcome> => ({
            kind: 'skipped',
            reason,
            // Only a door that answers needs the text in the team's language.
            message: this.answers(request)
                ? await (await judge()).translate(message, language)
                : message,
        });

        switch (resolution.kind) {
            case 'no_reference':
                return skip('no_reference', messages.noReferenceMessage());
            case 'no_tracker':
                return skip('no_tracker', messages.noTrackerMessage());
            case 'no_capable_tracker':
                return skip(
                    'no_capable_tracker',
                    messages.noCapableTrackerMessage(references, trackerNames),
                );
            case 'not_found':
                return skip(
                    'task_not_found',
                    messages.taskNotFoundMessage(resolution.attempts),
                );
            case 'tracker_unavailable':
                return skip(
                    'tracker_unavailable',
                    messages.trackerUnavailableMessage(resolution.attempts),
                );
        }

        const { task } = resolution;
        const quality = gradeTask(task);
        if (!canJudgeAgainst(quality)) {
            return {
                kind: 'task_too_thin',
                task,
                message: await (
                    await judge()
                ).translate(messages.taskTooThinMessage(task), language),
            };
        }

        const diff = await this.loadDiff(request);
        if (!diff.trim()) {
            return skip('diff_unavailable', messages.diffUnavailableMessage());
        }

        const verdict = await (
            await judge()
        ).judge({
            instructions: this.instructions(request),
            task,
            taskText: formatTaskForJudge(task),
            taskQuality: quality,
            diff,
            pullRequestBody: request.pullRequest?.body,
            userLanguage: language,
        });

        if (verdict.needsMoreInfo) {
            if (
                verdict.reason === 'analyzer_failure' ||
                verdict.reason === 'parser_fallback'
            ) {
                return skip('judge_failed', messages.judgeFailedMessage());
            }
            // The judge read the task and found nothing to check the code against.
            return {
                kind: 'task_too_thin',
                task,
                message: await (
                    await judge()
                ).translate(
                    verdict.summary || messages.taskTooThinMessage(task),
                    language,
                ),
            };
        }

        return { kind: 'validated', task, verdict, report: verdict.summary };
    }

    /** The command and the CLI answer every request; the review answers only with a verdict. */
    private answers(request: BusinessValidationRequest): boolean {
        return request.door === 'command' || request.door === 'cli';
    }

    /** Text given to the command that is not a reference is the task itself. */
    private inlineTask(
        taskInput: string | undefined,
        references: TaskReference[],
    ): Task | undefined {
        const text = taskInput?.trim() ?? '';
        if (text.length < MIN_INLINE_TASK) {
            return undefined;
        }
        if (references.some((r) => r.source === 'command')) {
            return undefined;
        }
        return {
            tracker: 'the command',
            id: 'Task in the command',
            description: text,
        };
    }

    private async connections(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<MCPServerConfig[]> {
        try {
            return (
                (await this.mcpManagerService.getConnections(
                    organizationAndTeamData,
                )) ?? []
            );
        } catch (error) {
            this.logger.warn({
                message: 'Business validation could not list MCP connections',
                context: BusinessValidationService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            return [];
        }
    }

    private repositoryOf(request: BusinessValidationRequest) {
        const repository = request.repository;
        if (!repository) {
            return undefined;
        }
        const owner =
            repository.owner ??
            (repository.fullName?.includes('/')
                ? repository.fullName.slice(
                      0,
                      repository.fullName.lastIndexOf('/'),
                  )
                : undefined);
        return { owner, name: repository.name };
    }

    private async loadDiff(
        request: BusinessValidationRequest,
    ): Promise<string> {
        try {
            return typeof request.diff === 'function'
                ? ((await request.diff()) ?? '')
                : (request.diff ?? '');
        } catch (error) {
            this.logger.warn({
                message:
                    'Business validation could not load the pull request diff',
                context: BusinessValidationService.name,
                error,
                metadata: {
                    organizationId:
                        request.organizationAndTeamData.organizationId,
                    pullRequest: request.pullRequest?.number,
                },
            });
            return '';
        }
    }

    private async judge(
        request: BusinessValidationRequest,
    ): Promise<IntentJudge> {
        const overrideRef =
            request.byokModelId?.trim() || request.byokModel?.trim();
        const model =
            (await this.permissionValidationService.resolveTaskSlot(
                request.organizationAndTeamData,
                LLM_TASK.businessValidation,
                {
                    ctx: overrideRef
                        ? { override: { modelId: overrideRef } }
                        : {},
                },
            )) ?? undefined;

        return new IntentJudge(
            model,
            this.policy(),
            {
                organizationId: request.organizationAndTeamData.organizationId,
                teamId: request.organizationAndTeamData.teamId,
                pullRequestId: request.pullRequest?.number,
                repositoryId: request.repository?.id,
            },
            this.byokErrorCounter
                ? (error) => void this.byokErrorCounter!.record(error)
                : undefined,
        );
    }

    private policy(): JudgePolicy {
        const meta =
            this.skillLoaderService.loadSkillMetaFromFilesystem(
                BUSINESS_VALIDATION_SKILL,
            ) ?? {};
        const policy = meta.executionPolicy ?? {};
        return {
            analyzerTimeoutMs: policy.analyzerTimeoutMs ?? 120_000,
            analyzerMaxIterations: policy.analyzerMaxIterations ?? 1,
            verifyAnalyzerResult: policy.verifyAnalyzerResult,
        };
    }

    /** SKILL.md, the team's custom instructions and the skill's reference material. */
    private instructions(request: BusinessValidationRequest): string {
        const base = this.skillLoaderService.loadInstructions(
            BUSINESS_VALIDATION_SKILL,
            {
                organizationId: request.organizationAndTeamData.organizationId,
                teamId: request.organizationAndTeamData.teamId,
                customInstructions: request.customInstructions,
            },
        );
        const references = this.skillLoaderService
            .listReferences(BUSINESS_VALIDATION_SKILL)
            .map((file) =>
                this.skillLoaderService.loadReference(
                    BUSINESS_VALIDATION_SKILL,
                    file,
                ),
            )
            .filter((content): content is string => !!content?.trim())
            .map((content) => content.trim());
        return references.length
            ? `${base}\n\n---\n\n## Reference Material\n\n${references.join('\n\n---\n\n')}`
            : base;
    }

    private async language(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        if (!organizationAndTeamData.teamId) {
            return DEFAULT_LANGUAGE;
        }
        try {
            const language = await this.parametersService.findByKey(
                ParametersKey.LANGUAGE_CONFIG,
                organizationAndTeamData,
            );
            return language?.configValue ?? DEFAULT_LANGUAGE;
        } catch {
            return DEFAULT_LANGUAGE;
        }
    }

    private record(
        request: BusinessValidationRequest,
        outcome: BusinessValidationOutcome,
        references: TaskReference[],
        attempts: ResolutionAttempt[],
    ): void {
        const reason =
            outcome.kind === 'skipped'
                ? outcome.reason
                : outcome.kind === 'validated'
                  ? (outcome.verdict.status ?? 'unknown')
                  : 'task_too_thin';
        this.metricsCollector?.recordCounter(
            'kodus_business_logic_validation_outcome_total',
            1,
            {
                skill: BUSINESS_VALIDATION_SKILL,
                door: request.door,
                outcome: outcome.kind,
                reason,
            },
        );
        this.logger.log({
            message: `Business validation ${outcome.kind} (${reason})`,
            context: BusinessValidationService.name,
            metadata: {
                organizationId: request.organizationAndTeamData.organizationId,
                teamId: request.organizationAndTeamData.teamId,
                repositoryId: request.repository?.id,
                pullRequest: request.pullRequest?.number,
                door: request.door,
                references: references.map(
                    (r) => `${r.kind}:${r.id}@${r.source}`,
                ),
                attempts,
            },
        });
    }
}
