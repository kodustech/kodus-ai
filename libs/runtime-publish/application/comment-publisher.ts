import { randomUUID } from 'crypto';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { createLogger } from '@libs/core/log/logger';
import { COMMENT_PHASES, type RuntimePublishRequested } from '@libs/runtime/run';

import { commentMarkerOf, publishEnvironmentOf } from '../domain/publish-environment';
import type { PullRequestCommentSlotStore, PullRequestRef } from '../domain/pull-request-comment-slot';
import {
    hasCommentMarker,
    renderProgressComment,
    renderReportComment,
    renderUndeliveredReportComment,
    runtimeLinks,
    withPreview,
    withCommentMarker,
    type RuntimeLinks,
} from '../domain/render-runtime-comment';
import type { PublicationStore, PublishedCommentRef } from '../domain/runtime-publication';
import type { CodeManagementPort, CommentAuthorPort, CommentSlotWait, OwnCommentAuthor, PlatformComment } from '../domain/runtime-publish.ports';
import { PublicationBusyError, PublicationFailedError, type PublishOptions, type PublishOutcome, type PublishTarget } from './publication-outcome';

type Logger = ReturnType<typeof createLogger>;

/** The log context of every publication line, whichever publisher writes it. */
export const PUBLISH_LOG_CONTEXT = 'PublishRuntimeRequestUseCase';

/** The Run's one PR comment: created once, then edited by each phase and the report. */
export class CommentPublisher {
    constructor(
        private readonly publications: PublicationStore,
        private readonly commentSlots: PullRequestCommentSlotStore,
        private readonly codeManagement: CodeManagementPort,
        private readonly slotWait: CommentSlotWait,
        private readonly dashboardUrl: string | undefined,
        private readonly logger: Logger,
        /** Absent: who Kody posts as is unknown, so a lost create is never adopted (a new comment is posted). */
        private readonly authors?: CommentAuthorPort,
    ) {}

    /**
     * One comment per PR, edited (screen 6), under the PR's comment slot: two
     * phases delivered at once never both create, an older phase never
     * overwrites a newer one, and a create whose answer was lost is found by
     * its marker instead of posted again.
     */
    async publish(
        msg: RuntimePublishRequested,
        target: PublishTarget,
        options: PublishOptions,
    ): Promise<PublishOutcome> {
        const { scope, organizationAndTeamData, repository, platformType } =
            target;
        // One comment per environment the PR runs in: a later Run of another environment never overwrites this one.
        const environment = publishEnvironmentOf({ repositoryId: scope.repositoryId, workspace: target.workspace });
        const marker = commentMarkerOf(environment);
        const pr: PullRequestRef = {
            organizationId: scope.organizationId,
            teamId: scope.teamId,
            repositoryId: scope.repositoryId,
            prNumber: scope.prNumber,
            ...(environment.key ? { environmentKey: environment.key } : {}),
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
            const links = withPreview(runtimeLinks(this.dashboardUrl, { runId: msg.runId, repositoryId: scope.repositoryId }), this.dashboardUrl, msg.runId, target.preview);
            const fallback = !!options.fallback && !!msg.report;
            const params = {
                organizationAndTeamData,
                repository: { id: repository.id, name: repository.name },
                prNumber: scope.prNumber,
                body: withCommentMarker(commentBodyOf(msg, links, fallback, target.workspace), marker),
            };
            const done = fallback ? { fallback: true } : {};

            const existing =
                slot.comment ??
                (slot.createPending
                    ? await this.findMarkedComment(params, platformType, marker)
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
                    context: PUBLISH_LOG_CONTEXT,
                    error,
                    metadata: { key: msg.key },
                }),
            );
        }
    }

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

    /**
     * Edits the PR comment. False when the comment is gone or no longer
     * Kody's to edit (403, 404, 410): the caller creates a new one. Any other
     * error is thrown so the broker retries, never turned into a duplicate.
     * On Bitbucket, Azure Repos and Forgejo the service answers null for any
     * failed edit, a deleted comment included: it is retried as a failure,
     * and the redrive gives up on a comment that is gone.
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
        let edited: unknown;
        try {
            edited = await this.codeManagement.updateIssueComment(
                {
                    ...params,
                    commentId: ref.id as number,
                    noteId: (ref.noteId ?? ref.id) as number,
                    threadId: ref.threadId as number,
                    // A deleted comment then throws its 404 or 410, and is replaced below, on every platform.
                    failOnError: true,
                },
                platformType,
            );
        } catch (error) {
            const status = httpStatusOf(error);
            if (status === 403 || status === 404 || status === 410) {
                this.logger.warn({
                    message: 'The Runtime PR comment can no longer be edited; posting a new one',
                    context: PUBLISH_LOG_CONTEXT,
                    metadata: { status, prNumber: params.prNumber },
                });
                return false;
            }
            throw error;
        }
        // These services log a failed edit (a 5xx, a rate limit, a deleted
        // comment alike) and answer null instead of throwing; GitHub and
        // GitLab throw it. Retried, never recorded as published.
        if (!edited && NULL_ON_FAILED_EDIT.has(platformType)) {
            throw new Error('the platform did not edit the Runtime PR comment');
        }
        return true;
    }

    /**
     * The marked Runtime comment of this PR, if a create whose answer was
     * lost did post it: only one Kody wrote. A PR author can type the marker
     * too, and Kody would then edit a comment they can rewrite (#11).
     */
    private async findMarkedComment(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string };
            prNumber: number;
        },
        platformType: PlatformType,
        marker: string,
    ): Promise<PublishedCommentRef | null> {
        const own = (await this.authors?.ownAuthor(params.organizationAndTeamData, platformType)) ?? null;
        if (!own) return null;
        const comments = await this.codeManagement.getAllCommentsInPullRequest(
            {
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
                failOnError: true,
            },
            platformType,
        );
        const marked = (comments ?? []).filter((c) => hasCommentMarker(c?.body, marker) && isOwnComment(c, own));
        return marked.length
            ? recoveredCommentRef(marked[marked.length - 1], platformType)
            : null;
    }
}

/** Platforms whose updateIssueComment answers null for a failed edit and a value for a done one. */
const NULL_ON_FAILED_EDIT: ReadonlySet<PlatformType> = new Set([PlatformType.BITBUCKET, PlatformType.AZURE_REPOS, PlatformType.FORGEJO]);

/**
 * Whether a listed comment is the integration's own: posted by its GitHub
 * App, or by the account its token belongs to (GitHub and Forgejo
 * `user.id`, GitLab, Bitbucket and Azure `author.id`). An author it cannot
 * read is not its own.
 */
export function isOwnComment(comment: any, own: OwnCommentAuthor): boolean {
    if (own.githubAppId !== undefined && comment?.performed_via_github_app?.id === own.githubAppId) return true;
    const author = comment?.user?.id ?? comment?.author?.id ?? comment?.user?.uuid ?? comment?.author?.uuid;
    return author !== undefined && author !== null && author !== '' && own.userIds.includes(String(author));
}

/** The comment body: the progress, the report, or the short notice that stands in for an undeliverable report. */
function commentBodyOf(
    msg: RuntimePublishRequested,
    links: RuntimeLinks,
    fallback: boolean,
    workspace: PublishTarget['workspace'],
): string {
    if (msg.progress) return renderProgressComment(msg.progress, links);
    return fallback
        ? renderUndeliveredReportComment(msg.report!, links)
        : renderReportComment(msg.report!, links, workspace ? { workspace } : {});
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

function httpStatusOf(error: unknown): number | undefined {
    const e = error as { status?: unknown; response?: { status?: unknown } };
    const status = e?.status ?? e?.response?.status;
    return typeof status === 'number' ? status : undefined;
}

/** The ids needed to edit a comment later, from the platform's create answer. */
export function toPublishedCommentRef(
    created: PlatformComment | null | undefined,
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
    listed: PlatformComment | null | undefined,
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
