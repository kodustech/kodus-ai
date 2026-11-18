import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { publishKey, RuntimeEventName, RuntimePublishRequestedSchema, type RuntimePublishRequested } from '@libs/runtime/run';

import { RUNTIME_PR_CHECK_SLOT_STORE_TOKEN, type PullRequestCheckSlotStore } from '../domain/pull-request-check-slot';
import { RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN, type PullRequestCommentSlotStore } from '../domain/pull-request-comment-slot';
import { storableRequestOf } from '../domain/publication-redrive';
import { RUNTIME_RUN_TARGET_STORE_TOKEN, type RunTargetStore } from '../domain/run-target';
import { CHECK_STATUS_RANK, type PublicationScope, type PublicationStore } from '../domain/runtime-publication';
import {
    RUNTIME_PUBLICATION_STORE_TOKEN,
    RUNTIME_PUBLISH_CHECKS_TOKEN,
    RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN,
    RUNTIME_PUBLISH_COMMENT_AUTHOR_TOKEN,
    RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN,
    RUNTIME_PUBLISH_PREVIEW_OFFER_TOKEN,
    type PreviewOfferReader,
    RUNTIME_PUBLISH_METRICS_TOKEN,
    RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN,
    RUNTIME_PUBLISH_SLOT_WAIT_TOKEN,
    RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN,
    type ChecksPort,
    type CodeManagementPort,
    type CommentAuthorPort,
    type CommentSlotWait,
    type PublishMetrics,
    type RepositoryResolver,
    type SuggestionResolver,
} from '../domain/runtime-publish.ports';
import { CheckPublisher } from './check-publisher';
import { CommentPublisher } from './comment-publisher';
import { PublicationBusyError, PublicationFailedError, type PublishOptions, type PublishOutcome, type PublishTarget, type RefusalReason } from './publication-outcome';
import { ReplyPublisher } from './reply-publisher';

// The product worker's side of the publication contract: the Runtime asks, the product
// publishes with its own Git credentials. The message names a Run and gives
// structured fields; where to say it (org, team, repo, PR, SHA) comes only
// from the target the product stored when it enqueued the Run
// (`runtime_run_targets`), and what to say only from the product's renderer.
// No free text of the Runtime reaches the PR.

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

/** A slot wait long enough for one comment edit on the platform. */
export const DEFAULT_SLOT_WAIT: CommentSlotWait = { maxWaitMs: 10_000 };

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
    private readonly comments: CommentPublisher;
    private readonly checkRuns: CheckPublisher;
    private readonly replies: ReplyPublisher;

    constructor(
        @Inject(RUNTIME_RUN_TARGET_STORE_TOKEN)
        private readonly targets: Pick<RunTargetStore, 'get'>,
        @Inject(RUNTIME_PUBLICATION_STORE_TOKEN)
        private readonly publications: PublicationStore,
        @Inject(RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN)
        commentSlots: PullRequestCommentSlotStore,
        @Inject(RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN)
        private readonly repositories: RepositoryResolver,
        @Inject(RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN)
        private readonly codeManagement: CodeManagementPort,
        @Inject(RUNTIME_PUBLISH_CHECKS_TOKEN)
        checks: ChecksPort,
        @Optional()
        @Inject(RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN)
        suggestions?: SuggestionResolver,
        @Optional()
        @Inject(RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN)
        dashboardUrl?: string,
        @Optional()
        @Inject(RUNTIME_PUBLISH_METRICS_TOKEN)
        private readonly metrics?: PublishMetrics,
        @Optional()
        @Inject(RUNTIME_PUBLISH_SLOT_WAIT_TOKEN)
        slotWait: CommentSlotWait = DEFAULT_SLOT_WAIT,
        @Optional()
        @Inject(RUNTIME_PUBLISH_PREVIEW_OFFER_TOKEN)
        private readonly previewOffers?: PreviewOfferReader,
        @Optional()
        @Inject(RUNTIME_PUBLISH_COMMENT_AUTHOR_TOKEN)
        authors?: CommentAuthorPort,
        // The module always provides it; a test without it publishes checks unordered.
        @Optional()
        @Inject(RUNTIME_PR_CHECK_SLOT_STORE_TOKEN)
        checkSlots?: PullRequestCheckSlotStore,
    ) {
        this.comments = new CommentPublisher(publications, commentSlots, codeManagement, slotWait, dashboardUrl, this.logger, authors);
        this.checkRuns = new CheckPublisher(publications, checks, dashboardUrl, this.logger, checkSlots);
        this.replies = new ReplyPublisher(publications, codeManagement, suggestions, dashboardUrl);
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
            await this.replies.publish(msg, resolved);
            return { outcome: 'duplicate', key: msg.key };
        }
        if (claim.state === 'busy') {
            throw new PublicationBusyError(msg.key);
        }

        let outcome: PublishOutcome;
        try {
            outcome =
                msg.kind === 'comment'
                    ? await this.comments.publish(msg, resolved, options)
                    : await this.checkRuns.publish(msg, resolved, claim.publication, options);
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
            await this.replies.publish(msg, resolved);
        }
        return outcome;
    }

    private async resolveTarget(
        msg: RuntimePublishRequested,
    ): Promise<PublishTarget | { refused: PublishOutcome }> {
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
        // Only a result offers a preview; unreadable settings offer none (the comment still goes out).
        const preview =
            msg.report && this.previewOffers
                ? await this.previewOffers.offerFor({ organizationId: scope.organizationId, ...(stored.fork !== undefined ? { fork: stored.fork } : {}) }).catch((error: unknown) => {
                      this.logger.warn({
                          message: 'Runtime publication: preview settings unreadable, the comment goes out without a preview',
                          context: PublishRuntimeRequestUseCase.name,
                          error: error instanceof Error ? error : undefined,
                          metadata: { runId: msg.runId, key: msg.key, organizationId: scope.organizationId, correlationId: msg.correlationId },
                      });
                      return null;
                  })
                : null;
        return {
            scope,
            organizationAndTeamData,
            repository,
            platformType,
            // What ran beside the PR comes from the product's record too, never from the Runtime's report.
            ...(stored.workspace?.length ? { workspace: stored.workspace } : {}),
            ...(preview ? { preview } : {}),
        };
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

/**
 * Only structured fields are published: a comment is one `report`
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
 * `runId:attempt:kind`; `runId:attempt:comment:<phase>` for a progress
 * comment; or `runId:attempt:check:awaiting_approval` for the fork check that
 * waits for a maintainer: completed with action_required only. Replies are
 * keyed by ReplyPublisher (`runId:attempt:reply:<suggestionId>`).
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

/** check, comment or unknown: never a value of the message as a metric label. */
function metricKindOf(raw: unknown): string {
    const payload = isRecord(raw) && isRecord(raw.payload) ? raw.payload : raw;
    const kind = isRecord(payload) ? payload.kind : undefined;
    return kind === 'check' || kind === 'comment' ? kind : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
