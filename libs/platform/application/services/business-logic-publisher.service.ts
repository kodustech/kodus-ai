import { randomUUID } from 'node:crypto';

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
    type RenderContext,
} from '@libs/agents/business-validation/render';
import {
    buildRun,
    checkedCommits,
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
import { createLogger } from '@libs/core/log/logger';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import type { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';

import { withRepositoryReader } from './business-logic-repository-reader';

/** The PR a door acts on, so its files can pick the directory's settings. */
export interface PullRequestScope {
    number: number;
    repositoryName: string;
    platformType?: string;
}

/** The settings, switch and model a door outside the review runs with. */
export interface DoorConfig {
    settings: BusinessLogicSettings;
    /** `reviewOptions.business_logic` for the PR's repository or directory. */
    enabled: boolean;
    byokModel?: string;
    byokModelId?: string;
}

export interface PublishInput {
    request: BusinessValidationRequest;
    result: BusinessValidationResult;
    settings?: BusinessLogicSettings;
    /** The commit the run read, named in the comment. */
    headSha?: string;
    trigger?: RenderContext['trigger'] | 'auto';
    commits?: CommitInfo[];
    authorLogin?: string;
    dryRun?: boolean;
    /** A re-check's first skip, carried so its window closes (UC-22). */
    pendingSince?: Date;
    /** The preview posted, so the same seal never posts twice. */
    previewId?: string;
}

/** What a publish would put on the PR, without writing anything. */
export interface PublishPreview {
    outcome: BusinessValidationOutcome;
    comment: {
        /** Whether this run would post or edit the comment. */
        posted: boolean;
        /** Why it would not, when it would not. */
        reason?: string;
        /** The comment as it would read, also when it would not be posted. */
        body?: string;
        /** An earlier run's comment would be edited in place. */
        editsExisting: boolean;
    };
}

export interface PublishResult {
    outcome: BusinessValidationOutcome;
    runId?: string;
    comment: 'created' | 'updated' | 'none';
}

/**
 * Puts a business-logic outcome on the PR, the same way for every door and
 * every Git platform: one comment, edited in place on every re-check (UC-34,
 * UC-35), and the run recorded for the timeline, the settings card and the
 * Cockpit. No check: only some platforms have one, and the comment is the
 * signal everywhere.
 */
@Injectable()
export class BusinessLogicPublisher {
    private readonly logger = createLogger(BusinessLogicPublisher.name);

    constructor(
        private readonly businessValidationService: BusinessValidationService,
        private readonly codeManagementService: CodeManagementService,
        private readonly runs: ValidationRunRepository,
        @Optional()
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService?: ICodeBaseConfigService,
        @Optional()
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService?: IPullRequestsService,
    ) {}

    /** The Business Logic settings, for a door outside the review pipeline. */
    async settingsFor(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string | undefined,
        pullRequest?: PullRequestScope,
    ): Promise<BusinessLogicSettings> {
        return (
            await this.configFor(
                organizationAndTeamData,
                repositoryId,
                pullRequest,
            )
        ).settings;
    }

    /**
     * What a door outside the review pipeline runs with, resolved the way the
     * review resolves it: a PR's files pick the directory whose settings
     * apply, so the command, a reply and a re-check use the same task source,
     * re-check rule and model as the review of that PR.
     */
    async configFor(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string | undefined,
        pullRequest?: PullRequestScope,
    ): Promise<DoorConfig> {
        try {
            const files =
                repositoryId && pullRequest
                    ? ((await this.codeManagementService
                          .getFilesByPullRequestId(
                              {
                                  organizationAndTeamData,
                                  repository: {
                                      id: repositoryId,
                                      name: pullRequest.repositoryName,
                                  },
                                  prNumber: pullRequest.number,
                              },
                              pullRequest.platformType as
                                  PlatformType | undefined,
                          )
                          .catch((error) => {
                              // Without the files the repository's own
                              // settings apply, not a directory's.
                              this.logger.warn({
                                  message:
                                      "Could not list the PR's files: Business Logic uses the repository settings",
                                  context: BusinessLogicPublisher.name,
                                  error,
                                  metadata: {
                                      organizationId:
                                          organizationAndTeamData.organizationId,
                                      repositoryId,
                                      pullRequest: pullRequest.number,
                                  },
                              });
                              return [];
                          })) ?? [])
                    : [];
            const config = (await this.codeBaseConfigService?.getSimpleConfig(
                organizationAndTeamData,
                { repositoryId, preliminaryFiles: files as any },
            )) as
                | {
                      businessLogic?: BusinessLogicConfig;
                      reviewOptions?: { business_logic?: boolean };
                      byokModel?: string;
                      byokModelId?: string;
                  }
                | undefined;
            return {
                settings: resolveBusinessLogicSettings(config?.businessLogic),
                // No config read: the doors keep working as before.
                enabled: config
                    ? config.reviewOptions?.business_logic !== false
                    : true,
                ...(config?.byokModel ? { byokModel: config.byokModel } : {}),
                ...(config?.byokModelId
                    ? { byokModelId: config.byokModelId }
                    : {}),
            };
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not read the Business Logic config: the defaults apply',
                context: BusinessLogicPublisher.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    repositoryId,
                    pullRequest: pullRequest?.number,
                },
            });
            return { settings: DEFAULT_BUSINESS_LOGIC_SETTINGS, enabled: true };
        }
    }

    /** The request with the repository at the PR head to read, for the gap check. */
    withRepository(
        request: BusinessValidationRequest,
    ): BusinessValidationRequest {
        return withRepositoryReader(request, this.codeManagementService);
    }

    /**
     * Whether the PR's last verdict failed: no task when one is required, or
     * a requirement the team fails on and nobody accepted. A skipped run
     * (a tracker down, a diff that didn't load) doesn't change that.
     */
    async lastVerdictFailed(scope: {
        organizationId: string;
        repositoryId: string;
        pullRequestNumber: number;
    }): Promise<boolean> {
        const runs = await this.runs.forPullRequest(scope).catch(() => []);
        return runs.find((r) => r.outcome !== 'skipped')?.passed === false;
    }

    /** The commit a PR is at, named in the comment. */
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

    /**
     * What `publish` would do with this result, read-only: the comment as it
     * would read and whether it would be posted. Accepted findings from
     * earlier runs are carried over the same way.
     */
    async preview(input: PublishInput): Promise<PublishPreview> {
        const { request } = input;
        const settings = input.settings ?? DEFAULT_BUSINESS_LOGIC_SETTINGS;
        const { outcome, previousComment, history } =
            await this.carriedOver(input);
        const posted = this.shouldComment(outcome, settings, previousComment);
        const body = await this.businessValidationService.commentFor(
            outcome,
            request,
            { headSha: input.headSha, history },
        );
        return {
            outcome,
            comment: {
                posted: posted && !!body,
                editsExisting: !!previousComment?.comment,
                ...(body ? { body } : {}),
                ...(posted
                    ? {}
                    : {
                          reason:
                              outcome.kind === 'skipped'
                                  ? 'Nothing was checked, so nothing is posted.'
                                  : 'Every requirement is met, and "Comment when every requirement is met" is off, so Kody stays quiet.',
                      }),
            },
        };
    }

    /** The outcome with what earlier runs decided (accepted findings), and the comment to edit. */
    private async carriedOver(input: PublishInput) {
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
        const [earlier, previousComment] = scope
            ? await Promise.all([
                  this.runs.forPullRequest(scope).catch(() => []),
                  this.runs
                      .latestForPullRequest({ ...scope, withComment: true })
                      .catch(() => undefined),
              ])
            : [[], undefined];
        const previousVerdict = earlier.find((r) => r.outcome === 'validated');
        const outcome = carryOver(input.result.outcome, previousVerdict?.tasks);
        const history = checkedCommits(earlier, input.headSha);
        return { scope, outcome, previousComment, history };
    }

    async publish(input: PublishInput): Promise<PublishResult> {
        const { request } = input;
        const settings = input.settings ?? DEFAULT_BUSINESS_LOGIC_SETTINGS;
        const { scope, outcome, previousComment, history } =
            await this.carriedOver(input);
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
                    history,
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
                if (action === 'created' && comment) {
                    await this.recordSuggestion(
                        request,
                        outcome,
                        comment,
                        body,
                    );
                }
            }
        }

        const runId = await this.runs.create({
            ...buildRun(request, result, {
                trigger: input.trigger,
                headSha: input.headSha,
                author: detectAuthor(input.commits, input.authorLogin),
                pendingSince: input.pendingSince,
                previewId: input.previewId,
            }),
            ...(comment ? { comment } : {}),
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
     * A passing PR is commented unless the team turned that off (UC-26), and
     * a comment already there is always brought up to date. Anything the
     * author can act on is always commented.
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
                // A comment deleted on the PR, or one Kody can no longer
                // edit, is replaced by a new one; otherwise the PR would
                // never get a Business Logic comment again.
                const updated = await this.codeManagementService
                    .updateIssueComment(
                        {
                            ...target,
                            body,
                            commentId: existing.id as number,
                            noteId: (existing.noteId ?? existing.id) as number,
                            threadId: existing.threadId as number,
                        },
                        platform,
                    )
                    .then(() => true)
                    .catch(() => false);
                if (updated) {
                    return { comment: existing, action: 'updated' };
                }
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

    /**
     * The comment as a PR-level suggestion of the review's record, so its
     * reactions and implemented rate count Business Logic like any other
     * PR-level comment. One per comment: a re-check edits it in place.
     */
    private async recordSuggestion(
        request: BusinessValidationRequest,
        outcome: BusinessValidationOutcome,
        comment: RunComment,
        body: string,
    ): Promise<void> {
        if (
            !this.pullRequestsService ||
            !request.pullRequest ||
            !request.repository
        ) {
            return;
        }
        const passed = outcome.kind === 'validated' && outcome.passed;
        const now = new Date().toISOString();
        await this.pullRequestsService
            .addPrLevelSuggestions(
                request.pullRequest.number,
                request.repository.name,
                [
                    {
                        id: randomUUID(),
                        suggestionContent: body,
                        oneSentenceSummary: passed
                            ? 'Business logic validation passed — PR aligns with task requirements.'
                            : 'Business logic gap detected based on PR requirements.',
                        label: LabelType.BUSINESS_LOGIC,
                        severity: passed
                            ? SeverityLevel.LOW
                            : SeverityLevel.MEDIUM,
                        priorityStatus: PriorityStatus.PRIORITIZED,
                        deliveryStatus: DeliveryStatus.SENT,
                        // A PR-level comment has no review id (as on Bitbucket).
                        comment: {
                            id: comment.id,
                        } as ISuggestionByPR['comment'],
                        createdAt: now,
                        updatedAt: now,
                    },
                ],
                request.organizationAndTeamData,
            )
            .catch((error) => {
                this.logger.warn({
                    message: `Could not record the business logic comment as a PR-level suggestion on PR#${request.pullRequest!.number}`,
                    context: BusinessLogicPublisher.name,
                    error,
                    metadata: {
                        organizationId:
                            request.organizationAndTeamData.organizationId,
                    },
                });
            });
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
