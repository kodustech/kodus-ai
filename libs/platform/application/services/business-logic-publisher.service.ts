import { Inject, Injectable, Optional } from '@nestjs/common';

import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import type {
    BusinessValidationOutcome,
    BusinessValidationRequest,
    BusinessValidationResult,
} from '@libs/agents/business-validation/business-validation.types';
import { carryOver } from '@libs/agents/business-validation/carry-over';
import {
    BUSINESS_LOGIC_COMMENT_MARKER,
    renderCheckTitle,
    type RenderContext,
} from '@libs/agents/business-validation/render';
import {
    buildRun,
    type CommitInfo,
    detectAuthor,
} from '@libs/agents/business-validation/runs/run-mapping';
import type { RunComment } from '@libs/agents/business-validation/runs/validation-run.model';
import {
    type ValidationRunRecord,
    ValidationRunRepository,
} from '@libs/agents/business-validation/runs/validation-run.repository';
import {
    type BusinessLogicConfig,
    type BusinessLogicSettings,
    DEFAULT_BUSINESS_LOGIC_SETTINGS,
    resolveBusinessLogicSettings,
} from '@libs/agents/business-validation/settings';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    type ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    CheckConclusion,
    CheckStatus,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { ChecksAdapterFactory } from '@libs/core/infrastructure/pipeline/services/checks-adapter.factory';
import { createLogger } from '@libs/core/log/logger';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

/** The check a team can require before merging. */
export const BUSINESS_LOGIC_CHECK_NAME = 'kody/business-logic';

const SKIP_TITLES: Record<string, string> = {
    no_reference: 'Skipped · no task referenced',
    too_many_references: 'Skipped · more tasks than one validation covers',
    no_tracker: 'Skipped · no task tracker connected',
    no_capable_tracker:
        "Skipped · the connected tracker can't read this reference",
    task_not_found: 'Skipped · no referenced task exists',
    tracker_unavailable:
        'Skipped · the task tracker is unavailable, not about this PR',
    diff_unavailable: "Skipped · the PR diff couldn't be loaded",
    judge_failed: "Skipped · the validation couldn't finish",
};

export interface PublishInput {
    request: BusinessValidationRequest;
    result: BusinessValidationResult;
    settings?: BusinessLogicSettings;
    /** The commit the run read. Needed for the check. */
    headSha?: string;
    trigger?: RenderContext['trigger'] | 'auto';
    commits?: CommitInfo[];
    authorLogin?: string;
    dryRun?: boolean;
}

export interface PublishResult {
    outcome: BusinessValidationOutcome;
    runId?: string;
    comment: 'created' | 'updated' | 'none';
}

/**
 * Puts a business-logic outcome on the PR, the same way for every door: one
 * comment, edited in place on every re-check (UC-34, UC-35), the
 * `kody/business-logic` check where the platform has checks, and the run
 * recorded for the timeline, the settings card and the Cockpit.
 */
@Injectable()
export class BusinessLogicPublisher {
    private readonly logger = createLogger(BusinessLogicPublisher.name);

    constructor(
        private readonly businessValidationService: BusinessValidationService,
        private readonly codeManagementService: CodeManagementService,
        private readonly checksAdapterFactory: ChecksAdapterFactory,
        private readonly runs: ValidationRunRepository,
        @Optional()
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService?: ICodeBaseConfigService,
    ) {}

    /** The repository's Business Logic settings, for a door outside the review pipeline. */
    async settingsFor(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string | undefined,
    ): Promise<BusinessLogicSettings> {
        try {
            const config = await this.codeBaseConfigService?.getSimpleConfig(
                organizationAndTeamData,
                { repositoryId },
            );
            return resolveBusinessLogicSettings(
                (config as { businessLogic?: BusinessLogicConfig } | undefined)
                    ?.businessLogic,
            );
        } catch {
            return DEFAULT_BUSINESS_LOGIC_SETTINGS;
        }
    }

    /** The commit a PR is at, for the check. */
    async headShaOf(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        prNumber: number,
        platformType?: string,
    ): Promise<string | undefined> {
        try {
            const pr = (await this.codeManagementService.getPullRequest(
                { organizationAndTeamData, repository, prNumber },
                platformType as PlatformType,
            )) as { head?: { sha?: string } } | null;
            return pr?.head?.sha;
        } catch {
            return undefined;
        }
    }

    async publish(input: PublishInput): Promise<PublishResult> {
        const { request } = input;
        const settings = input.settings ?? DEFAULT_BUSINESS_LOGIC_SETTINGS;
        const pr = request.pullRequest;
        const repository = request.repository;
        const scope =
            pr && repository
                ? {
                      organizationId:
                          request.organizationAndTeamData.organizationId,
                      repositoryId: repository.id,
                      pullRequestNumber: pr.number,
                  }
                : undefined;

        const [previousVerdict, previousComment] = scope
            ? await Promise.all([
                  this.runs
                      .latestForPullRequest({ ...scope, outcome: 'validated' })
                      .catch(() => undefined),
                  this.runs
                      .latestForPullRequest({ ...scope, withComment: true })
                      .catch(() => undefined),
              ])
            : [undefined, undefined];

        const outcome = carryOver(
            input.result.outcome,
            previousVerdict?.tasks,
            settings.failOn,
        );
        const result = { ...input.result, outcome };

        let comment: RunComment | undefined;
        let action: PublishResult['comment'] = 'none';
        if (
            scope &&
            !input.dryRun &&
            this.shouldComment(outcome, settings, previousComment)
        ) {
            const body = await this.businessValidationService.commentFor(
                outcome,
                request,
                {
                    headSha: input.headSha,
                    trigger:
                        input.trigger === 'auto' ? undefined : input.trigger,
                },
            );
            if (body) {
                ({ comment, action } = await this.writeComment(
                    request,
                    body,
                    previousComment,
                ));
            }
        }

        const checkRunId =
            scope && !input.dryRun && input.headSha
                ? await this.writeCheck(request, outcome, input.headSha)
                : undefined;

        const runId = await this.runs.create({
            ...buildRun(request, result, {
                trigger: input.trigger,
                headSha: input.headSha,
                author: detectAuthor(input.commits, input.authorLogin),
            }),
            ...(comment ? { comment } : {}),
            ...(checkRunId ? { checkRunId } : {}),
        });
        if (
            scope &&
            !(
                outcome.kind === 'skipped' &&
                outcome.reason === 'tracker_unavailable'
            )
        ) {
            // An earlier run waiting on the tracker is answered by this one.
            await this.runs.clearPendingRecheck(scope);
        }
        return { outcome, runId, comment: action };
    }

    /**
     * A passing PR gets only the green check unless the team wants a comment
     * (UC-26), or there is already a comment to bring up to date. Anything
     * the author can act on is always commented.
     */
    private shouldComment(
        outcome: BusinessValidationOutcome,
        settings: BusinessLogicSettings,
        previous: ValidationRunRecord | undefined,
    ): boolean {
        if (outcome.kind === 'skipped') {
            return false;
        }
        if (outcome.kind !== 'validated') {
            return true;
        }
        if (previous?.comment) {
            return true;
        }
        const nothingToDo =
            outcome.passed &&
            outcome.checks.every(
                (c) =>
                    !(c.verdict.requirements ?? []).some(
                        (r) => r.state !== 'met' && !r.accepted,
                    ) && !(c.verdict.outOfScope ?? []).some((o) => !o.accepted),
            );
        return !nothingToDo || settings.commentWhenMet;
    }

    private async writeComment(
        request: BusinessValidationRequest,
        body: string,
        previous: ValidationRunRecord | undefined,
    ): Promise<{ comment?: RunComment; action: PublishResult['comment'] }> {
        const target = {
            organizationAndTeamData: request.organizationAndTeamData,
            prNumber: request.pullRequest!.number,
            repository: {
                id: request.repository!.id,
                name: request.repository!.name,
            },
        };
        const platform = request.platformType as PlatformType | undefined;
        try {
            const existing =
                previous?.comment ??
                (await this.findByMarker(target, platform));
            if (existing) {
                await this.codeManagementService.updateIssueComment(
                    {
                        ...target,
                        body,
                        commentId: existing.id as number,
                        noteId: (existing.noteId ?? existing.id) as number,
                        threadId: existing.threadId as number,
                    },
                    platform,
                );
                return { comment: existing, action: 'updated' };
            }
            const created = await this.codeManagementService.createIssueComment(
                { ...target, body },
                platform,
            );
            return {
                comment: commentIds(created, platform),
                action: created ? 'created' : 'none',
            };
        } catch (error) {
            // A review must not fail because a comment could not be posted.
            this.logger.warn({
                message: `Could not post the business logic comment on PR#${target.prNumber}`,
                context: BusinessLogicPublisher.name,
                error,
                metadata: {
                    organizationId:
                        request.organizationAndTeamData.organizationId,
                    prNumber: target.prNumber,
                },
            });
            return { action: 'none' };
        }
    }

    /** For PRs commented before runs were recorded: find the comment by its marker. */
    private async findByMarker(
        target: {
            organizationAndTeamData: BusinessValidationRequest['organizationAndTeamData'];
            prNumber: number;
            repository: { id: string; name: string };
        },
        platform: PlatformType | undefined,
    ): Promise<RunComment | undefined> {
        const comments =
            ((await this.codeManagementService
                .getAllCommentsInPullRequest(target, platform)
                .catch(() => [])) as Array<Record<string, any>>) ?? [];
        const match = comments.find((c) => {
            const text = c?.body ?? c?.note ?? c?.content;
            return (
                typeof text === 'string' &&
                text.includes(BUSINESS_LOGIC_COMMENT_MARKER)
            );
        });
        if (!match) {
            return undefined;
        }
        const id = match.id ?? match.commentId ?? match.note_id;
        return id !== undefined
            ? {
                  id,
                  ...(match.threadId ? { threadId: match.threadId } : {}),
              }
            : undefined;
    }

    /** GitHub and Forgejo only; elsewhere the comment is the whole signal. */
    private async writeCheck(
        request: BusinessValidationRequest,
        outcome: BusinessValidationOutcome,
        headSha: string,
    ): Promise<string | undefined> {
        const platform = request.platformType as PlatformType;
        if (
            platform !== PlatformType.GITHUB &&
            platform !== PlatformType.FORGEJO
        ) {
            return undefined;
        }
        const repository = request.repository!;
        const owner =
            repository.owner ??
            (repository.fullName?.includes('/')
                ? repository.fullName.slice(
                      0,
                      repository.fullName.lastIndexOf('/'),
                  )
                : undefined);
        if (!owner) {
            return undefined;
        }
        const { conclusion, title } = checkFor(outcome);
        try {
            const adapter = this.checksAdapterFactory.getAdapter(platform);
            const target = {
                organizationAndTeamData: request.organizationAndTeamData,
                repository: { owner, name: repository.name },
            };
            const existing = await adapter.findCheckRun({
                ...target,
                headSha,
                name: BUSINESS_LOGIC_CHECK_NAME,
            });
            const output = {
                title,
                summary:
                    outcome.kind === 'validated'
                        ? 'See the Kody · Business Logic comment on the pull request.'
                        : title,
            };
            if (existing) {
                await adapter.updateCheckRun({
                    ...target,
                    checkRunId: existing,
                    status: CheckStatus.COMPLETED,
                    conclusion,
                    output,
                });
                return String(existing);
            }
            const id = await adapter.createCheckRun({
                ...target,
                headSha,
                status: CheckStatus.IN_PROGRESS,
                name: BUSINESS_LOGIC_CHECK_NAME,
                output,
            });
            if (id === null || id === undefined) {
                return undefined;
            }
            await adapter.updateCheckRun({
                ...target,
                checkRunId: id,
                status: CheckStatus.COMPLETED,
                conclusion,
                output,
            });
            return String(id);
        } catch (error) {
            this.logger.warn({
                message: 'Could not write the business logic check',
                context: BusinessLogicPublisher.name,
                error,
                metadata: {
                    organizationId:
                        request.organizationAndTeamData.organizationId,
                    prNumber: request.pullRequest?.number,
                },
            });
            return undefined;
        }
    }
}

export function checkFor(outcome: BusinessValidationOutcome): {
    conclusion: CheckConclusion;
    title: string;
} {
    switch (outcome.kind) {
        case 'validated':
            return {
                conclusion: outcome.passed
                    ? CheckConclusion.SUCCESS
                    : CheckConclusion.FAILURE,
                title: renderCheckTitle(outcome),
            };
        case 'task_too_thin':
            return {
                conclusion: CheckConclusion.NEUTRAL,
                title: `${outcome.tasks.map((t) => t.id).join(', ')} has too little to check against`,
            };
        case 'task_missing':
            return {
                conclusion: CheckConclusion.NEUTRAL,
                title: `${outcome.references.map((r) => r.raw).join(', ')} doesn't exist in ${outcome.tracker}`,
            };
        case 'skipped':
            return {
                conclusion: CheckConclusion.SKIPPED,
                title: SKIP_TITLES[outcome.reason] ?? 'Skipped',
            };
    }
}

function commentIds(
    created: any,
    platform: PlatformType | undefined,
): RunComment | undefined {
    if (!created || created.id === undefined || created.id === null) {
        return undefined;
    }
    return {
        id: created.id,
        ...(platform === PlatformType.GITLAB && created.notes?.[0]?.id
            ? { noteId: created.notes[0].id }
            : {}),
        ...(platform === PlatformType.AZURE_REPOS && created.threadId
            ? { threadId: created.threadId }
            : {}),
    };
}
