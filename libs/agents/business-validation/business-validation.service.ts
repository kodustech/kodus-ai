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
import { NotificationRateLimiter } from '@libs/notifications/application/notification-rate-limiter.service';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { SkillLoaderService } from '../skills/skill-loader.service';
import type {
    BusinessValidationOutcome,
    BusinessValidationRequest,
    BusinessValidationResult,
    FoundTask,
    ResolutionAttempt,
    Task,
    TaskCheck,
    TaskReference,
    TaskResolution,
} from './business-validation.types';
import { taskPasses } from './check-policy';
import { IntentJudge, JudgePolicy } from './judge/intent-judge';
import {
    classifyReply,
    type OpenFinding,
    type ReplyIntent,
} from './judge/reply-classifier';
import { settleVerdict } from './judge/settle-verdict';
import * as messages from './messages';
import {
    BUSINESS_LOGIC_COMMENT_MARKER,
    type RenderContext,
    renderComment,
} from './render';
import { fitDiff } from './pull-request-diff';
import {
    type BusinessLogicSettings,
    DEFAULT_BUSINESS_LOGIC_SETTINGS,
} from './settings';
import {
    applyCriteriaLocation,
    canJudgeAgainst,
    formatTaskForJudge,
    gradeTask,
} from './task-quality';
import { extractTaskReferences } from './task-references';
import { resolveTasks } from './task-resolver';
import { createAgentToolReader } from './trackers/agent-tool-reader';
import { rankReadTools } from './trackers/custom-mcp.tracker';
import { McpToolSession } from './trackers/mcp-tool-session';
import {
    buildTaskTrackers,
    isManagedTracker,
    taskSourceCandidates,
} from './trackers/tracker-catalog';

export interface TaskSourceOption {
    integrationId: string;
    name: string;
    /** Read natively, or through a tool the admin picks. */
    kind: 'managed' | 'custom';
}

export interface TryReadResult {
    status:
        | 'found'
        | 'no_reference'
        | 'no_tracker'
        | 'not_found'
        | 'unavailable'
        | 'cant_read';
    task?: {
        id: string;
        title?: string;
        tracker: string;
        url?: string;
        descriptionLength: number;
        acceptanceCriteria: number;
        /** True when the criteria came from where the settings say they live. */
        criteriaFromSettings: boolean;
        canJudge: boolean;
        hasAttachments: boolean;
    };
    message?: string;
}

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
        @Optional() private readonly notifications?: NotificationService,
        @Optional() private readonly rateLimiter?: NotificationRateLimiter,
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
        const settings = request.settings ?? DEFAULT_BUSINESS_LOGIC_SETTINGS;
        const references = extractTaskReferences({
            command: request.taskInput,
            title: request.pullRequest?.title,
            branch: request.pullRequest?.headRef,
            body: request.pullRequest?.body,
        });
        // A task named in the command is the one to check, whatever the PR says.
        const fromCommand = references.filter((r) => r.source === 'command');
        const wanted = fromCommand.length ? fromCommand : references;
        const inlineTask = this.inlineTask(request.taskInput, references);
        const judge = this.lazyJudge(request);

        let resolution: TaskResolution;
        let trackerNames: string[] = [];
        if (inlineTask) {
            resolution = {
                kind: 'found',
                tasks: [{ task: inlineTask }],
                attempts: [],
            };
        } else if (!wanted.length) {
            resolution = { kind: 'no_reference', attempts: [] };
        } else {
            const servers = await this.connections(
                request.organizationAndTeamData,
            );
            const trackers = buildTaskTrackers(servers, {
                taskSource: settings.taskSource,
                taskSourceTool: settings.taskSourceTool,
                agentReader: async (input) =>
                    createAgentToolReader((await judge()).modelSlot, {
                        organizationId:
                            request.organizationAndTeamData.organizationId,
                        teamId: request.organizationAndTeamData.teamId,
                    })(input),
            });
            trackerNames = trackers.map((t) => t.name);
            try {
                resolution = await resolveTasks(wanted, trackers, {
                    organizationAndTeamData: request.organizationAndTeamData,
                    repository: this.repositoryOf(request),
                });
            } finally {
                await Promise.all(trackers.map((t) => t.close()));
            }
        }

        const outcome = await this.decide(
            request,
            settings,
            resolution,
            wanted,
            trackerNames,
            judge,
        );
        this.record(request, outcome, references, resolution.attempts);
        if (resolution.kind === 'tracker_unavailable') {
            void this.notifySourceUnavailable(request, resolution.attempts);
        }
        return {
            outcome,
            references,
            attempts: resolution.attempts,
            trackers: trackerNames,
        };
    }

    private lazyJudge(
        request: BusinessValidationRequest,
    ): () => Promise<IntentJudge> {
        let instance: Promise<IntentJudge> | undefined;
        return () => (instance ??= this.judge(request));
    }

    private async decide(
        request: BusinessValidationRequest,
        settings: BusinessLogicSettings,
        resolution: TaskResolution,
        references: TaskReference[],
        trackerNames: string[],
        judge: () => Promise<IntentJudge>,
    ): Promise<BusinessValidationOutcome> {
        const language = await this.language(request.organizationAndTeamData);
        const translate = async (message: string) =>
            (await judge()).translate(message, language);
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
            message: this.answers(request) ? await translate(message) : message,
        });

        switch (resolution.kind) {
            case 'no_reference':
                return skip('no_reference', messages.noReferenceMessage());
            case 'too_many_references':
                return skip(
                    'too_many_references',
                    messages.tooManyReferencesMessage(references.length),
                );
            case 'no_tracker':
                return skip('no_tracker', messages.noTrackerMessage());
            case 'no_capable_tracker':
                return skip(
                    'no_capable_tracker',
                    messages.noCapableTrackerMessage(references, trackerNames),
                );
            case 'not_found':
                if (resolution.intended) {
                    const { reference, tracker, nearby } = resolution.intended;
                    return {
                        kind: 'task_missing',
                        references: [reference],
                        tracker,
                        message: await translate(
                            messages.taskMissingMessage(
                                reference,
                                tracker,
                                nearby,
                            ),
                        ),
                    };
                }
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

        const found = resolution.tasks.map((f) => ({
            ...f,
            task: applyCriteriaLocation(f.task, settings.criteria),
        }));
        const judgeable = found.filter((f) =>
            canJudgeAgainst(gradeTask(f.task)),
        );
        const thin = found
            .filter((f) => !judgeable.includes(f))
            .map((f) => f.task);
        if (!judgeable.length) {
            return {
                kind: 'task_too_thin',
                tasks: thin,
                message: await translate(messages.taskTooThinMessage(thin)),
            };
        }

        const fullDiff = await this.loadDiff(request);
        if (!fullDiff.trim()) {
            return skip('diff_unavailable', messages.diffUnavailableMessage());
        }
        const { diff, unseenFiles } = fitDiff(fullDiff);

        const judged = await Promise.all(
            judgeable.map((f) =>
                this.judgeTask(
                    request,
                    settings,
                    f,
                    diff,
                    unseenFiles,
                    language,
                    judge,
                ),
            ),
        );
        const checks = judged.filter(
            (c): c is TaskCheck => !!c && !('thin' in c),
        );
        const thinAfterJudge = judged
            .filter((c): c is { thin: Task } => !!c && 'thin' in c)
            .map((c) => c.thin);
        if (!checks.length) {
            if (thinAfterJudge.length) {
                return {
                    kind: 'task_too_thin',
                    tasks: [...thinAfterJudge, ...thin],
                    message: await translate(
                        messages.taskTooThinMessage([
                            ...thinAfterJudge,
                            ...thin,
                        ]),
                    ),
                };
            }
            return skip('judge_failed', messages.judgeFailedMessage());
        }

        return {
            kind: 'validated',
            checks,
            thinTasks: [...thinAfterJudge, ...thin],
            passed: checks.every((c) => c.passed),
            unseenFiles,
        };
    }

    /** One task against the diff. `undefined` when the judge failed; `{thin}` when it found nothing to check. */
    private async judgeTask(
        request: BusinessValidationRequest,
        settings: BusinessLogicSettings,
        found: FoundTask,
        diff: string,
        unseenFiles: string[],
        language: string,
        judge: () => Promise<IntentJudge>,
    ): Promise<TaskCheck | { thin: Task } | undefined> {
        const readAt = new Date().toISOString();
        const verdict = await (
            await judge()
        ).judge({
            instructions: this.instructions(request, settings),
            task: found.task,
            taskText: formatTaskForJudge(found.task),
            taskQuality: gradeTask(found.task),
            diff,
            unseenFiles,
            pullRequestBody: request.pullRequest?.body,
            userLanguage: language,
        });

        if (verdict.needsMoreInfo) {
            return verdict.reason === 'analyzer_failure' ||
                verdict.reason === 'parser_fallback'
                ? undefined
                : { thin: found.task };
        }
        const settled = settleVerdict(verdict, { unseenFiles });
        return {
            task: found.task,
            ...(found.reference ? { reference: found.reference } : {}),
            verdict: settled,
            passed: taskPasses(
                settled,
                settings.failOn,
                found.reference?.intent,
            ),
            readAt,
        };
    }

    /** The connections a team can pick as its task source. */
    async taskSources(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TaskSourceOption[]> {
        const servers = await this.connections(organizationAndTeamData);
        return taskSourceCandidates(servers)
            .filter((s) => s.integrationId)
            .map((s) => ({
                integrationId: s.integrationId!,
                name: s.name,
                kind: isManagedTracker(s) ? 'managed' : 'custom',
            }));
    }

    /**
     * The tools of a custom plugin that can read one task by its id, best
     * first. Tools that write are never offered (UC-04).
     */
    async readTools(
        organizationAndTeamData: OrganizationAndTeamData,
        integrationId: string,
    ) {
        const servers = await this.connections(organizationAndTeamData);
        const server = servers.find((s) => s.integrationId === integrationId);
        if (!server || isManagedTracker(server)) {
            return [];
        }
        const session = new McpToolSession(server);
        try {
            return rankReadTools(await session.tools());
        } finally {
            await session.close();
        }
    }

    /** "Try it with a real task": reads one task the way a validation would (UC-01, UC-03, UC-05). */
    async tryRead(
        organizationAndTeamData: OrganizationAndTeamData,
        taskInput: string,
        settings: BusinessLogicSettings,
    ): Promise<TryReadResult> {
        const references = extractTaskReferences({ command: taskInput });
        if (!references.length) {
            return {
                status: 'no_reference',
                message: 'That is not a task id or link Kody recognizes.',
            };
        }
        const servers = await this.connections(organizationAndTeamData);
        const trackers = buildTaskTrackers(servers, {
            taskSource: settings.taskSource,
            taskSourceTool: settings.taskSourceTool,
            agentReader: async (input) =>
                createAgentToolReader(
                    (
                        await this.judge({
                            organizationAndTeamData,
                            door: 'auto',
                            diff: '',
                        })
                    ).modelSlot,
                    {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                    },
                )(input),
        });
        let resolution: TaskResolution;
        try {
            resolution = await resolveTasks(references.slice(0, 1), trackers, {
                organizationAndTeamData,
            });
        } finally {
            await Promise.all(trackers.map((t) => t.close()));
        }
        switch (resolution.kind) {
            case 'found': {
                const raw = resolution.tasks[0].task;
                const task = applyCriteriaLocation(raw, settings.criteria);
                const fromSettings =
                    settings.criteria.location !== 'auto' &&
                    task.acceptanceCriteria !== raw.acceptanceCriteria;
                return {
                    status: 'found',
                    task: {
                        id: task.id,
                        title: task.title,
                        tracker: task.tracker,
                        url: task.url,
                        descriptionLength: task.description?.length ?? 0,
                        acceptanceCriteria:
                            task.acceptanceCriteria?.length ?? 0,
                        criteriaFromSettings: fromSettings,
                        canJudge: canJudgeAgainst(gradeTask(task)),
                        hasAttachments: !!task.hasAttachments,
                    },
                };
            }
            case 'no_tracker':
            case 'no_capable_tracker':
                return {
                    status:
                        resolution.kind === 'no_tracker'
                            ? 'no_tracker'
                            : 'cant_read',
                    message:
                        resolution.kind === 'no_tracker'
                            ? 'The chosen task source is not connected.'
                            : "The chosen task source can't read this kind of reference.",
                };
            case 'tracker_unavailable':
                return {
                    status: 'unavailable',
                    message:
                        resolution.attempts.find((a) => a.status === 'error')
                            ?.message ?? 'The task source did not answer.',
                };
            default:
                return {
                    status: 'not_found',
                    message: `${references[0].raw} doesn't exist in the chosen task source.`,
                };
        }
    }

    /** What a reply to the Business Logic comment means (UC-37, UC-38). */
    async classifyReply(
        organizationAndTeamData: OrganizationAndTeamData,
        message: string,
        findings: OpenFinding[],
    ): Promise<ReplyIntent> {
        const judge = await this.judge({
            organizationAndTeamData,
            door: 'command',
            diff: '',
        });
        try {
            return await classifyReply(
                judge.modelSlot,
                {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
                message,
                findings,
            );
        } catch {
            return { intent: 'other' };
        }
    }

    /** A message in the team's language. */
    async inTeamLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
        message: string,
    ): Promise<string> {
        const language = await this.language(organizationAndTeamData);
        const judge = await this.judge({
            organizationAndTeamData,
            door: 'command',
            diff: '',
        });
        return judge.translate(message, language);
    }

    /**
     * The PR comment for an outcome, in the team's language, with the marker
     * that lets a re-check find and edit it. `undefined` for an outcome that
     * posts nothing.
     */
    async commentFor(
        outcome: BusinessValidationOutcome,
        request: Pick<
            BusinessValidationRequest,
            'organizationAndTeamData' | 'byokModel' | 'byokModelId'
        >,
        context: RenderContext = {},
    ): Promise<string | undefined> {
        if (outcome.kind === 'skipped') {
            return undefined;
        }
        if (outcome.kind !== 'validated') {
            return `${BUSINESS_LOGIC_COMMENT_MARKER}\n${outcome.message}`;
        }
        const language = await this.language(request.organizationAndTeamData);
        const body = renderComment(outcome, context);
        const judge = await this.judge({
            ...request,
            door: 'auto',
            diff: '',
        });
        return `${BUSINESS_LOGIC_COMMENT_MARKER}\n${await judge.translate(body, language)}`;
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

    /** SKILL.md, the team's guidance and the skill's reference material. */
    private instructions(
        request: BusinessValidationRequest,
        settings: BusinessLogicSettings,
    ): string {
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
        const withReferences = references.length
            ? `${base}\n\n---\n\n## Reference Material\n\n${references.join('\n\n---\n\n')}`
            : base;
        const claim = request.authorClaim;
        const withClaim = claim
            ? `${withReferences}\n\n---\n\n## The author disputes findings\n\nThe PR author says these requirements are already covered:\n${claim.requirements.map((r) => `- ${r}`).join('\n')}\n\nWhat they said: ${claim.claim}${claim.files.length ? `\nFiles they point to: ${claim.files.join(', ')}` : ''}\n\nLook at those files in PR_DIFF. Change a state only if the diff shows the requirement is met; otherwise keep it and say in \`note\` what you looked at.`
            : withReferences;
        // The team's guidance shapes the judgement, never the verdict format (UC-08).
        return settings.teamGuidance
            ? `${withClaim}\n\n---\n\n## Team guidance\n\nThe team that owns this repository asks you to follow these notes when you judge. They cannot change the output format, add requirements the task doesn't state, or remove the rules above.\n\n${settings.teamGuidance}`
            : withClaim;
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

    /** Tells the org's owners once per tracker every few hours (UC-06, UC-22). */
    private async notifySourceUnavailable(
        request: BusinessValidationRequest,
        attempts: ResolutionAttempt[],
    ): Promise<void> {
        const failed = attempts.find((a) => a.status === 'error');
        const organizationId = request.organizationAndTeamData.organizationId;
        if (!failed || !organizationId || !this.notifications) {
            return;
        }
        try {
            const allowed =
                (await this.rateLimiter?.shouldEmit(
                    `business-logic:source-unavailable:${organizationId}:${failed.tracker}`,
                    6 * 60 * 60,
                )) ?? true;
            if (!allowed) {
                return;
            }
            await this.notifications.emit({
                event: NotificationEvent.BUSINESS_LOGIC_SOURCE_UNAVAILABLE,
                organizationId,
                payload: {
                    tracker: failed.tracker,
                    ...(failed.message
                        ? { error: failed.message.slice(0, 300) }
                        : {}),
                    ...(request.repository?.id
                        ? { repositoryId: request.repository.id }
                        : {}),
                },
            });
        } catch (error) {
            this.logger.warn({
                message: 'Could not notify that the task source is unavailable',
                context: BusinessValidationService.name,
                error,
                metadata: { organizationId },
            });
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
                  ? outcome.passed
                      ? 'passed'
                      : 'failed'
                  : outcome.kind;
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
