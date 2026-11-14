import { randomUUID } from 'crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CheckConclusion,
    CheckStatus,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { createLogger } from '@libs/core/log/logger';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import {
    COMMENT_PHASES,
    publishKey,
    RuntimeEventName,
    RuntimePublishRequestedSchema,
    type RuntimePublishRequested,
} from '@libs/runtime/run';

import {
    RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN,
    type PullRequestCommentSlotStore,
    type PullRequestRef,
} from '../domain/pull-request-comment-slot';
import { storableRequestOf } from '../domain/publication-redrive';
import {
    hasCommentMarker,
    renderBareCheckOutput,
    renderCheckOutput,
    renderProgressComment,
    renderReportComment,
    renderSuggestionReply,
    renderUndeliveredCheckOutput,
    renderUndeliveredReportComment,
    runtimeLinks,
    withCommentMarker,
    type RuntimeLinks,
} from '../domain/render-runtime-comment';
import {
    RUNTIME_RUN_TARGET_STORE_TOKEN,
    type RunTargetStore,
} from '../domain/run-target';
import {
    CHECK_STATUS_RANK,
    type PublicationRetryState,
    type PublicationScope,
    type PublicationStore,
    type PublishedCommentRef,
    type RuntimePublication,
} from '../domain/runtime-publication';
import {
    CHECKS_PLATFORMS,
    KODY_RUNTIME_CHECK_NAME,
    RUNTIME_PUBLICATION_STORE_TOKEN,
    RUNTIME_PUBLISH_CHECKS_TOKEN,
    RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN,
    RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN,
    RUNTIME_PUBLISH_METRICS_TOKEN,
    RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN,
    RUNTIME_PUBLISH_SLOT_WAIT_TOKEN,
    RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN,
    type ChecksPort,
    type CodeManagementPort,
    type CommentSlotWait,
    type PublishMetrics,
    type PublishRepository,
    type RepositoryResolver,
    type SuggestionResolver,
} from '../domain/runtime-publish.ports';

// The product worker's side of ADR-052: the Runtime asks, the product
// publishes with its own Git credentials. The message names a Run and gives
// structured fields; where to say it (org, team, repo, PR, SHA) comes only
// from the target the product stored when it enqueued the Run
// (`runtime_run_targets`), and what to say only from the product's renderer.
// No free text of the Runtime reaches the PR.

export type RefusalReason =
    | 'invalid_message'
    | 'unexpected_event'
    | 'key_mismatch'
    | 'unstructured_body'
    | 'target_not_found'
    | 'attempt_mismatch'
    | 'incomplete_record'
    | 'repository_not_in_org'
    | 'repository_mismatch'
    | 'no_integration'
    | 'platform_mismatch';

/**
 * Refusals that mean the Runtime sent something the product never asked for:
 * a bug or tampering, logged as errors with `alert` so they page. A missing
 * target (a simulation, a Run enqueued before the target table) is expected.
 */
const ALERT_REFUSALS: ReadonlySet<RefusalReason> = new Set([
    'invalid_message',
    'key_mismatch',
    'unstructured_body',
    'attempt_mismatch',
    'incomplete_record',
    'repository_not_in_org',
    'repository_mismatch',
    'platform_mismatch',
]);

export type PublishOutcome =
    | {
          outcome: 'refused';
          reason: RefusalReason;
          runId?: string;
          key?: string;
      }
    | { outcome: 'duplicate'; key: string }
    | { outcome: 'published'; key: string; action: 'created' | 'updated' }
    | {
          outcome: 'skipped';
          key: string;
          reason: 'checks_unavailable' | 'stale_comment';
      };

/**
 * How a delivery is published. `fallback` is the redrive sweeper's last try
 * for a final publication the platform kept refusing: for the report comment,
 * the short notice of renderUndeliveredReportComment instead of the report,
 * so the PR comment never stays at "Writing the report"; for the completed
 * check, a neutral check with renderUndeliveredCheckOutput, so a required
 * check never stays open on the PR.
 */
export interface PublishOptions {
    fallback?: boolean;
}

/** A slot wait long enough for one comment edit on the platform. */
export const DEFAULT_SLOT_WAIT: CommentSlotWait = { maxWaitMs: 10_000 };

/** Another delivery of the same key (or of the same PR comment) is publishing right now; the broker retries later. */
export class PublicationBusyError extends Error {
    constructor(readonly key: string) {
        super(`publication ${key} is being published by another delivery`);
        this.name = 'PublicationBusyError';
    }
}

/** The platform did not take the publication; the broker retries. */
export class PublicationFailedError extends Error {
    constructor(
        readonly key: string,
        reason: string,
        /** What the retry needs: a check run opened before the failure, the create-failure count. */
        readonly keep?: PublicationRetryState,
    ) {
        super(`publication ${key} failed: ${reason}`);
        this.name = 'PublicationFailedError';
    }
}

/**
 * Deliveries whose check create answers no check run before the check is
 * given up as unavailable (PAT auth, no checks:write). The adapters answer
 * null for a transient error too, so one null is not enough to give up.
 */
export const MAX_CHECK_CREATE_ATTEMPTS = 3;

const WIRE_CONCLUSION: Record<
    NonNullable<NonNullable<RuntimePublishRequested['check']>['conclusion']>,
    CheckConclusion
> = {
    success: CheckConclusion.SUCCESS,
    failure: CheckConclusion.FAILURE,
    neutral: CheckConclusion.NEUTRAL,
    skipped: CheckConclusion.SKIPPED,
    action_required: CheckConclusion.ACTION_REQUIRED,
    cancelled: CheckConclusion.CANCELLED,
    timed_out: CheckConclusion.TIMED_OUT,
};

const WIRE_STATUS: Record<
    NonNullable<RuntimePublishRequested['check']>['status'],
    CheckStatus
> = {
    queued: CheckStatus.QUEUED,
    in_progress: CheckStatus.IN_PROGRESS,
    completed: CheckStatus.COMPLETED,
};

type Target = {
    scope: PublicationScope;
    organizationAndTeamData: OrganizationAndTeamData;
    repository: PublishRepository;
    platformType: PlatformType;
};

/**
 * The payload of a broker delivery: the envelope of
 * transformMessageToMessageBroker is unwrapped and the routing field
 * `workflowType` is dropped, so the strict schema sees only the message.
 */
export function unwrapPublishMessage(
    raw: unknown,
): { ok: true; value: unknown } | { ok: false; reason: RefusalReason } {
    let payload: unknown = raw;
    if (isRecord(raw) && 'event_name' in raw && 'payload' in raw) {
        if (raw.event_name !== RuntimeEventName.PublishRequested) {
            return { ok: false, reason: 'unexpected_event' };
        }
        payload = raw.payload;
    }
    if (!isRecord(payload)) {
        return { ok: false, reason: 'invalid_message' };
    }
    const { workflowType, ...rest } = payload;
    if (
        workflowType !== undefined &&
        workflowType !== WorkflowType.RUNTIME_PUBLISH
    ) {
        return { ok: false, reason: 'unexpected_event' };
    }
    return { ok: true, value: rest };
}

@Injectable()
export class PublishRuntimeRequestUseCase {
    private readonly logger = createLogger(PublishRuntimeRequestUseCase.name);

    constructor(
        @Inject(RUNTIME_RUN_TARGET_STORE_TOKEN)
        private readonly targets: Pick<RunTargetStore, 'get'>,
        @Inject(RUNTIME_PUBLICATION_STORE_TOKEN)
        private readonly publications: PublicationStore,
        @Inject(RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN)
        private readonly commentSlots: PullRequestCommentSlotStore,
        @Inject(RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN)
        private readonly repositories: RepositoryResolver,
        @Inject(RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN)
        private readonly codeManagement: CodeManagementPort,
        @Inject(RUNTIME_PUBLISH_CHECKS_TOKEN)
        private readonly checks: ChecksPort,
        @Optional()
        @Inject(RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN)
        private readonly suggestions?: SuggestionResolver,
        @Optional()
        @Inject(RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN)
        private readonly dashboardUrl?: string,
        @Optional()
        @Inject(RUNTIME_PUBLISH_METRICS_TOKEN)
        private readonly metrics?: PublishMetrics,
        @Optional()
        @Inject(RUNTIME_PUBLISH_SLOT_WAIT_TOKEN)
        private readonly slotWait: CommentSlotWait = DEFAULT_SLOT_WAIT,
    ) {}

    /**
     * The PR's comment slot, waited for a few seconds: a Run's phases (the last
     * progress and the report) arrive a second apart and each holds the slot for
     * one edit. Only a slot still held after the wait goes back to the broker,
     * whose retry may be slow or, with a broken delayed exchange, never come.
     */
    private async acquireSlot(pr: PullRequestRef, owner: string) {
        const sleep = this.slotWait.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        let waited = 0;
        let interval = 100;
        for (;;) {
            const slot = await this.commentSlots.acquire(pr, owner);
            if (slot || waited >= this.slotWait.maxWaitMs) return slot;
            const pause = Math.min(interval, this.slotWait.maxWaitMs - waited);
            await sleep(pause);
            waited += pause;
            interval = Math.min(interval * 2, 1_000);
        }
    }

    async execute(raw: unknown, options: PublishOptions = {}): Promise<PublishOutcome> {
        const startedAt = Date.now();
        const kind = metricKindOf(raw);
        try {
            const outcome = await this.publish(raw, options);
            this.metrics?.record({
                kind,
                outcome: outcome.outcome,
                reason: 'reason' in outcome ? outcome.reason : undefined,
                durationMs: Date.now() - startedAt,
            });
            return outcome;
        } catch (error) {
            this.metrics?.record({
                kind,
                outcome: 'retry',
                reason: error instanceof Error ? error.name : 'unknown',
                durationMs: Date.now() - startedAt,
            });
            throw error;
        }
    }

    private async publish(raw: unknown, options: PublishOptions): Promise<PublishOutcome> {
        const unwrapped = unwrapPublishMessage(raw);
        if ('reason' in unwrapped) {
            return this.refuse(unwrapped.reason);
        }
        const parsed = RuntimePublishRequestedSchema.safeParse(unwrapped.value);
        if (!parsed.success) {
            // Paths and codes only: an issue never echoes a value of the message.
            return this.refuse('invalid_message', undefined, {
                issues: parsed.error.issues
                    .slice(0, 5)
                    .map((i) => ({ path: i.path.join('.'), code: i.code })),
            });
        }
        const msg = parsed.data;
        if (!keyMatches(msg)) {
            return this.refuse('key_mismatch', msg);
        }
        const shape = shapeProblem(msg);
        if (shape) {
            return this.refuse(shape, msg, { kind: msg.kind });
        }

        const resolved = await this.resolveTarget(msg);
        if ('refused' in resolved) {
            return resolved.refused;
        }
        const { scope } = resolved;

        const claim = await this.publications.claim({
            key: msg.key,
            runId: msg.runId,
            attempt: msg.attempt,
            kind: msg.kind,
            ...scope,
            checkRank: msg.check
                ? CHECK_STATUS_RANK[msg.check.status]
                : undefined,
            // Kept so the product can publish it again if the broker's retry is lost.
            request: storableRequestOf(msg),
        });
        if (claim.state === 'duplicate') {
            this.logger.log({
                message: 'Runtime publication already done, skipping',
                context: PublishRuntimeRequestUseCase.name,
                metadata: {
                    key: msg.key,
                    status: claim.publication.status,
                    correlationId: msg.correlationId,
                },
            });
            // Replies have their own keys: a redelivery finishes the ones left.
            await this.publishReplies(msg, resolved);
            return { outcome: 'duplicate', key: msg.key };
        }
        if (claim.state === 'busy') {
            throw new PublicationBusyError(msg.key);
        }

        let outcome: PublishOutcome;
        try {
            outcome =
                msg.kind === 'comment'
                    ? await this.publishComment(msg, resolved, options)
                    : await this.publishCheck(msg, resolved, claim.publication, options);
            this.logger.log({
                message: `Runtime ${msg.kind} ${outcome.outcome}`,
                context: PublishRuntimeRequestUseCase.name,
                metadata: {
                    key: msg.key,
                    organizationId: scope.organizationId,
                    repositoryId: scope.repositoryId,
                    prNumber: scope.prNumber,
                    correlationId: msg.correlationId,
                },
            });
        } catch (error) {
            await this.publications.release(
                msg.key,
                error instanceof Error ? error.message : String(error),
                error instanceof PublicationFailedError ? error.keep : undefined,
            );
            throw error;
        }
        if (outcome.outcome === 'published') {
            await this.publishReplies(msg, resolved);
        }
        return outcome;
    }

    private links(scope: PublicationScope, runId: string): RuntimeLinks {
        return runtimeLinks(this.dashboardUrl, {
            runId,
            repositoryId: scope.repositoryId,
        });
    }

    private async resolveTarget(
        msg: RuntimePublishRequested,
    ): Promise<Target | { refused: PublishOutcome }> {
        const stored = await this.targets.get(msg.runId);
        if (!stored) {
            return { refused: this.refuse('target_not_found', msg) };
        }
        if (stored.attempt !== msg.attempt) {
            return {
                refused: this.refuse('attempt_mismatch', msg, {
                    recordAttempt: stored.attempt,
                }),
            };
        }
        if (
            !stored.organizationId ||
            !stored.teamId ||
            !stored.repositoryId ||
            !stored.pullRequestNumber ||
            !stored.headSha ||
            !stored.platform
        ) {
            return { refused: this.refuse('incomplete_record', msg) };
        }
        const scope: PublicationScope = {
            organizationId: stored.organizationId,
            teamId: stored.teamId,
            repositoryId: stored.repositoryId,
            prNumber: stored.pullRequestNumber,
            headSha: stored.headSha,
        };
        const organizationAndTeamData = {
            organizationId: scope.organizationId,
            teamId: scope.teamId,
        };
        // Defense in depth: the stored org and team must still own the stored
        // repository in the product's integration config.
        const repository = await this.repositories.resolve(
            organizationAndTeamData,
            scope.repositoryId,
        );
        if (!repository) {
            return {
                refused: this.refuse('repository_not_in_org', msg, {
                    organizationId: scope.organizationId,
                }),
            };
        }
        const names = [stored.repositoryName, stored.repositoryFullName].filter(
            Boolean,
        );
        if (
            names.length > 0 &&
            !names.some((n) => n === repository.name || n === repository.fullName)
        ) {
            return {
                refused: this.refuse('repository_mismatch', msg, {
                    organizationId: scope.organizationId,
                }),
            };
        }
        const platformType = await this.codeManagement.getTypeIntegration(
            organizationAndTeamData,
        );
        if (!platformType) {
            return {
                refused: this.refuse('no_integration', msg, {
                    organizationId: scope.organizationId,
                }),
            };
        }
        if (platformType !== stored.platform) {
            return {
                refused: this.refuse('platform_mismatch', msg, {
                    organizationId: scope.organizationId,
                }),
            };
        }
        return { scope, organizationAndTeamData, repository, platformType };
    }

    /**
     * One comment per PR, edited (screen 6), under the PR's comment slot: two
     * phases delivered at once never both create, an older phase never
     * overwrites a newer one, and a create whose answer was lost is found by
     * its marker instead of posted again.
     */
    private async publishComment(
        msg: RuntimePublishRequested,
        target: Target,
        options: PublishOptions,
    ): Promise<PublishOutcome> {
        const { scope, organizationAndTeamData, repository, platformType } =
            target;
        const pr: PullRequestRef = {
            organizationId: scope.organizationId,
            teamId: scope.teamId,
            repositoryId: scope.repositoryId,
            prNumber: scope.prNumber,
        };
        const owner = `${msg.key}#${randomUUID()}`;
        const slot = await this.acquireSlot(pr, owner);
        if (!slot) {
            throw new PublicationBusyError(msg.key);
        }
        try {
            const order = commentOrderOf(msg);
            if (
                order !== undefined &&
                slot.commentOrder !== undefined &&
                slot.commentOrder > order
            ) {
                await this.publications.complete(msg.key, {
                    status: 'skipped',
                    reason: 'stale_comment',
                });
                return { outcome: 'skipped', key: msg.key, reason: 'stale_comment' };
            }
            const commentOrder = order ?? slot.commentOrder;
            const links = this.links(scope, msg.runId);
            const fallback = !!options.fallback && !!msg.report;
            const params = {
                organizationAndTeamData,
                repository: { id: repository.id, name: repository.name },
                prNumber: scope.prNumber,
                body: withCommentMarker(commentBodyOf(msg, links, fallback)),
            };
            const done = fallback ? { fallback: true } : {};

            const existing =
                slot.comment ??
                (slot.createPending
                    ? await this.findMarkedComment(params, platformType)
                    : null);
            if (existing && (await this.editComment(existing, params, platformType))) {
                await this.commentSlots.update(pr, owner, {
                    comment: existing,
                    commentOrder,
                    createPending: false,
                });
                await this.publications.complete(msg.key, {
                    status: 'published',
                    comment: existing,
                    ...done,
                });
                return { outcome: 'published', key: msg.key, action: 'updated' };
            }

            // Recorded before the call: if the answer is lost, the next holder
            // looks for the marked comment first.
            await this.commentSlots.update(pr, owner, { createPending: true });
            const created = await this.codeManagement.createIssueComment(
                params,
                platformType,
            );
            const comment = toPublishedCommentRef(created, platformType);
            if (!comment) {
                throw new PublicationFailedError(
                    msg.key,
                    'the platform did not create the comment',
                );
            }
            await this.commentSlots.update(pr, owner, {
                comment,
                commentOrder,
                createPending: false,
            });
            await this.publications.complete(msg.key, {
                status: 'published',
                comment,
                ...done,
            });
            return { outcome: 'published', key: msg.key, action: 'created' };
        } finally {
            await this.commentSlots.release(pr, owner).catch((error) =>
                this.logger.warn({
                    message: 'Could not release the Runtime PR comment slot; its lease expires on its own',
                    context: PublishRuntimeRequestUseCase.name,
                    error,
                    metadata: { key: msg.key },
                }),
            );
        }
    }

    /**
     * Edits the PR comment. False when the comment is gone or no longer
     * Kody's to edit (403, 404, 410): the caller creates a new one. Any other
     * error is thrown so the broker retries, never turned into a duplicate.
     */
    private async editComment(
        ref: PublishedCommentRef,
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string };
            prNumber: number;
            body: string;
        },
        platformType: PlatformType,
    ): Promise<boolean> {
        try {
            await this.codeManagement.updateIssueComment(
                {
                    ...params,
                    commentId: ref.id as number,
                    noteId: (ref.noteId ?? ref.id) as number,
                    threadId: ref.threadId as number,
                },
                platformType,
            );
            return true;
        } catch (error) {
            const status = httpStatusOf(error);
            if (status === 403 || status === 404 || status === 410) {
                this.logger.warn({
                    message: 'The Runtime PR comment can no longer be edited; posting a new one',
                    context: PublishRuntimeRequestUseCase.name,
                    metadata: { status, prNumber: params.prNumber },
                });
                return false;
            }
            throw error;
        }
    }

    /** The marked Runtime comment of this PR, if a create whose answer was lost did post it. */
    private async findMarkedComment(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string };
            prNumber: number;
        },
        platformType: PlatformType,
    ): Promise<PublishedCommentRef | null> {
        const comments = await this.codeManagement.getAllCommentsInPullRequest(
            {
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
                failOnError: true,
            },
            platformType,
        );
        const marked = (comments ?? []).filter((c) => hasCommentMarker(c?.body));
        return marked.length
            ? recoveredCommentRef(marked[marked.length - 1], platformType)
            : null;
    }

    private async publishCheck(
        msg: RuntimePublishRequested,
        target: Target,
        publication: RuntimePublication,
        options: PublishOptions = {},
    ): Promise<PublishOutcome> {
        const { scope, organizationAndTeamData, repository, platformType } =
            target;
        const check = msg.check!;
        const status = WIRE_STATUS[check.status];
        const links = this.links(scope, msg.runId);
        // The sweeper's last try for a final check: close it neutral with the
        // short notice, so it never stays open on the PR.
        const fallback = !!options.fallback && check.status === 'completed';
        // Title, summary and (with a report) the conclusion come from the
        // product's verdict table; the Runtime's title and summary are unused.
        const rendered =
            msg.report && !fallback
                ? renderCheckOutput(msg.report, links)
                : undefined;
        const output = fallback
            ? renderUndeliveredCheckOutput(links)
            : rendered
              ? { title: rendered.title, summary: rendered.summary }
              : renderBareCheckOutput(check, links);
        const wireConclusion = fallback
            ? 'neutral'
            : check.status === 'completed'
              ? (rendered?.conclusion ?? check.conclusion)
              : check.conclusion;
        const done = fallback ? { fallback: true } : {};
        const conclusion = wireConclusion
            ? WIRE_CONCLUSION[wireConclusion]
            : undefined;
        const checkRank = CHECK_STATUS_RANK[check.status];

        if (!CHECKS_PLATFORMS.has(platformType)) {
            await this.publications.complete(msg.key, {
                status: 'skipped',
                reason: 'checks_unavailable',
            });
            return { outcome: 'skipped', key: msg.key, reason: 'checks_unavailable' };
        }

        const adapter = this.checks.getAdapter(platformType);
        const repo = { owner: repository.owner, name: repository.name };

        // The final verdict moves the check run the awaiting_approval phase
        // opened, recorded under that phase's own key.
        const finalKey = msg.key === publishKey(msg.runId, msg.attempt, 'check');
        let checkRunId =
            publication.checkRunId ??
            (finalKey
                ? await this.publications.findCheckRunId(
                      publishKey(msg.runId, msg.attempt, 'check', 'awaiting_approval'),
                  )
                : null) ??
            (await adapter.findCheckRun({
                organizationAndTeamData,
                repository: repo,
                headSha: scope.headSha,
                name: KODY_RUNTIME_CHECK_NAME,
            }));
        let action: 'created' | 'updated' = 'updated';

        if (!checkRunId) {
            // A run is created open and then closed: the create call carries
            // no conclusion.
            checkRunId = await adapter.createCheckRun({
                organizationAndTeamData,
                repository: repo,
                headSha: scope.headSha,
                status:
                    status === CheckStatus.COMPLETED
                        ? CheckStatus.IN_PROGRESS
                        : status,
                name: KODY_RUNTIME_CHECK_NAME,
                output,
            });
            action = 'created';
            if (!checkRunId) {
                // Null is both "this org cannot have checks" (PAT, no
                // checks:write) and a transient platform error: retry a few
                // deliveries, then let the comment carry the result.
                const failures = (publication.checkCreateFailures ?? 0) + 1;
                if (failures < MAX_CHECK_CREATE_ATTEMPTS) {
                    throw new PublicationFailedError(
                        msg.key,
                        'the platform did not create the check',
                        { checkCreateFailures: failures },
                    );
                }
                this.logger.warn({
                    message: 'Runtime check skipped: the platform created no check run after every attempt',
                    context: PublishRuntimeRequestUseCase.name,
                    metadata: { key: msg.key, attempts: failures, organizationId: scope.organizationId },
                });
                await this.publications.complete(msg.key, {
                    status: 'skipped',
                    reason: 'checks_unavailable',
                });
                return {
                    outcome: 'skipped',
                    key: msg.key,
                    reason: 'checks_unavailable',
                };
            }
            if (status !== CheckStatus.COMPLETED) {
                await this.publications.complete(msg.key, {
                    status: 'published',
                    checkRank,
                    checkRunId,
                    ...done,
                });
                return { outcome: 'published', key: msg.key, action };
            }
        }

        const updated = await adapter.updateCheckRun({
            organizationAndTeamData,
            repository: repo,
            checkRunId,
            status,
            conclusion,
            output,
        });
        if (!updated) {
            throw new PublicationFailedError(
                msg.key,
                'the platform did not update the check',
                { checkRunId },
            );
        }
        await this.publications.complete(msg.key, {
            status: 'published',
            checkRank,
            checkRunId,
            ...done,
        });
        return { outcome: 'published', key: msg.key, action };
    }

    /**
     * The replies on the review suggestions this Run reproduced (screen 7),
     * one key each. Best effort per suggestion: a suggestion the product
     * does not know on this PR, or a platform without threaded replies, is
     * skipped; a platform error throws so the broker retries the leftovers.
     */
    private async publishReplies(
        msg: RuntimePublishRequested,
        target: Target,
    ): Promise<void> {
        if (msg.kind !== 'comment' || !msg.report) return;
        const confirmed = msg.report.paths.filter(
            (p) =>
                p.suggestionId &&
                p.verdict === 'finding' &&
                p.intent !== 'intended',
        );
        if (!confirmed.length) return;
        const { scope, organizationAndTeamData, repository, platformType } =
            target;
        const links = this.links(scope, msg.runId);
        const seen = new Set<string>();
        for (const path of confirmed) {
            const suggestionId = path.suggestionId!;
            if (seen.has(suggestionId)) continue;
            seen.add(suggestionId);
            const key = `${msg.runId}:${msg.attempt}:reply:${suggestionId}`;
            const claim = await this.publications.claim({
                key,
                runId: msg.runId,
                attempt: msg.attempt,
                kind: 'reply',
                ...scope,
            });
            if (claim.state !== 'claimed') continue;
            if (platformType !== PlatformType.GITHUB || !this.suggestions) {
                await this.publications.complete(key, {
                    status: 'skipped',
                    reason: 'replies_unavailable',
                });
                continue;
            }
            const suggestion = await this.suggestions
                .resolve({
                    organizationAndTeamData,
                    repositoryId: scope.repositoryId,
                    prNumber: scope.prNumber,
                    suggestionId,
                })
                .catch(() => null);
            if (!suggestion) {
                await this.publications.complete(key, {
                    status: 'skipped',
                    reason: 'suggestion_not_found',
                });
                continue;
            }
            try {
                const reply = await this.codeManagement.createResponseToComment(
                    {
                        organizationAndTeamData,
                        repository: { id: repository.id, name: repository.name },
                        prNumber: scope.prNumber,
                        inReplyToId: suggestion.commentId,
                        body: renderSuggestionReply(path, links),
                    },
                    platformType,
                );
                const ref = toPublishedCommentRef(reply, platformType);
                await this.publications.complete(key, {
                    status: 'published',
                    ...(ref ? { comment: ref } : {}),
                });
            } catch (error) {
                await this.publications.release(
                    key,
                    error instanceof Error ? error.message : String(error),
                );
                throw new PublicationFailedError(
                    key,
                    'the platform did not take the reply',
                );
            }
        }
    }

    private refuse(
        reason: RefusalReason,
        msg?: Pick<RuntimePublishRequested, 'runId' | 'key' | 'correlationId'>,
        extra?: Record<string, unknown>,
    ): PublishOutcome {
        const alert = ALERT_REFUSALS.has(reason);
        this.logger[alert ? 'error' : 'warn']({
            message: `Runtime publication refused: ${reason}`,
            context: PublishRuntimeRequestUseCase.name,
            metadata: {
                reason,
                ...(alert ? { alert: 'runtime_publish_refused' } : {}),
                runId: msg?.runId,
                key: msg?.key,
                correlationId: msg?.correlationId,
                ...extra,
            },
        });
        return { outcome: 'refused', reason, runId: msg?.runId, key: msg?.key };
    }
}

/** The comment body: the progress, the report, or the short notice that stands in for an undeliverable report. */
function commentBodyOf(
    msg: RuntimePublishRequested,
    links: RuntimeLinks,
    fallback: boolean,
): string {
    if (msg.progress) return renderProgressComment(msg.progress, links);
    return fallback
        ? renderUndeliveredReportComment(msg.report!, links)
        : renderReportComment(msg.report!, links);
}

/**
 * Only structured fields are published (ADR-052): a comment is one `report`
 * or one `progress`, rendered by the product. Free text (`comment.body`) is
 * refused, and a completed check without a report is accepted only for the
 * fork that waits for a maintainer, whose wording is the product's.
 */
function shapeProblem(msg: RuntimePublishRequested): RefusalReason | null {
    if (msg.comment) return 'unstructured_body';
    if (msg.kind === 'comment') {
        const bodies = [msg.report, msg.progress].filter(Boolean).length;
        return bodies === 1 && !msg.check ? null : 'invalid_message';
    }
    if (!msg.check || msg.progress) return 'invalid_message';
    if (msg.check.status !== 'completed') return null;
    // A completed check without a conclusion would have no honest state.
    if (!msg.check.conclusion) return 'invalid_message';
    return msg.report || msg.check.conclusion === 'action_required'
        ? null
        : 'unstructured_body';
}

/**
 * `runId:attempt:kind`, or `runId:attempt:check:awaiting_approval` for the
 * fork check that waits for a maintainer: completed with action_required only.
 */
function keyMatches(msg: RuntimePublishRequested): boolean {
    if (msg.kind === 'comment' && msg.progress) {
        return (
            msg.key ===
            publishKey(msg.runId, msg.attempt, 'comment', msg.progress.phase)
        );
    }
    if (msg.key === publishKey(msg.runId, msg.attempt, msg.kind)) {
        return true;
    }
    return (
        msg.kind === 'check' &&
        msg.check?.status === 'completed' &&
        msg.check.conclusion === 'action_required' &&
        msg.key === publishKey(msg.runId, msg.attempt, 'check', 'awaiting_approval')
    );
}

/**
 * Order of a comment: the Run's request time in ms, then the phase (1 to 4)
 * or the result (9), as one number. A comment never overwrites one of a later
 * Run or a later phase; numbers, so ISO strings of other precisions compare right.
 */
export function commentOrderOf(
    msg: Pick<RuntimePublishRequested, 'progress' | 'report'>,
): number | undefined {
    const at = (iso: string) => Date.parse(iso) * 10;
    if (msg.progress) {
        return at(msg.progress.requestedAt) + COMMENT_PHASES.indexOf(msg.progress.phase) + 1;
    }
    if (msg.report) return at(msg.report.requestedAt) + 9;
    return undefined;
}

/** check, comment or unknown: never a value of the message as a metric label. */
function metricKindOf(raw: unknown): string {
    const payload = isRecord(raw) && isRecord(raw.payload) ? raw.payload : raw;
    const kind = isRecord(payload) ? payload.kind : undefined;
    return kind === 'check' || kind === 'comment' ? kind : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpStatusOf(error: unknown): number | undefined {
    const e = error as { status?: unknown; response?: { status?: unknown } };
    const status = e?.status ?? e?.response?.status;
    return typeof status === 'number' ? status : undefined;
}

/** The ids needed to edit a comment later, from the platform's create answer. */
export function toPublishedCommentRef(
    created: any,
    platformType: PlatformType,
): PublishedCommentRef | null {
    if (!created || created.id === undefined || created.id === null) {
        return null;
    }
    return {
        id: created.id,
        ...(platformType === PlatformType.GITLAB && created.notes?.[0]?.id
            ? { noteId: created.notes[0].id }
            : {}),
        ...(platformType === PlatformType.AZURE_REPOS && created.threadId
            ? { threadId: created.threadId }
            : {}),
    };
}

/**
 * The same ids from a listed comment (getAllCommentsInPullRequest): GitLab
 * lists notes with their discussion as `threadId`, Azure comments with theirs.
 */
export function recoveredCommentRef(
    listed: any,
    platformType: PlatformType,
): PublishedCommentRef | null {
    if (!listed || listed.id === undefined || listed.id === null) return null;
    if (platformType === PlatformType.GITLAB && listed.threadId) {
        return { id: listed.threadId, noteId: listed.id };
    }
    if (platformType === PlatformType.AZURE_REPOS && listed.threadId) {
        return { id: listed.id, threadId: listed.threadId };
    }
    return { id: listed.id };
}
