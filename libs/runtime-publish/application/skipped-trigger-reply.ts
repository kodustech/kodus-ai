import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { renderSkippedTriggerReply, skippedTriggerMarker, skippedTriggerReplyKey, type SkippedSetupState, type SkippedTriggerLinks } from '../domain/render-skipped-trigger';
import type { PublicationStore, PublishedCommentRef } from '../domain/runtime-publication';
import type { CodeManagementPort, CommentAuthorPort, RepositoryResolver } from '../domain/runtime-publish.ports';
import { hasCommentMarker, runtimeLinks } from '../domain/render-runtime-comment';
import { isOwnComment, recoveredCommentRef, toPublishedCommentRef } from './comment-publisher';
import { PublicationBusyError, PublicationFailedError } from './publication-outcome';

/** A `@kody runtime` comment that started no Run, as the trigger decided it. */
export interface SkippedTriggerReplyRequest {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    prNumber: number;
    /** The head the trigger read from the Git API, else the one the webhook saw. */
    headSha?: string;
    reason: string;
    /** For `environment_not_ready`: where the setup stands. */
    setup?: SkippedSetupState;
}

export type SkippedTriggerReplyOutcome =
    | { outcome: 'silent' }
    | { outcome: 'published'; key: string; action: 'created' | 'found' }
    | { outcome: 'duplicate'; key: string }
    /** Nowhere to answer: the repository is not the team's, or the team has no Git integration. */
    | { outcome: 'refused'; reason: 'repository_not_in_org' | 'no_integration' };

/** Where the product worker's trigger finds the publisher (RuntimeApiModule provides it). */
export const RUNTIME_SKIPPED_TRIGGER_REPLY_TOKEN = Symbol.for('RuntimeSkippedTriggerReply');

/** The kind of the answer's runtime_publications row. */
export const SKIPPED_TRIGGER_REPLY_KIND = 'skip_reply';

/** Stands in for the head in the key when neither the Git API nor the webhook named one. */
const NO_HEAD = 'no-head';

/**
 * The one line the product posts on a PR when `@kody runtime` started no Run
 * (render-skipped-trigger.ts), at most once per PR, head and reason. The row
 * of runtime_publications under that key is the claim: a redelivery or a retry
 * finds it published and posts nothing; a post whose platform answer was lost
 * is found by its marker, on a comment Kody itself wrote (anyone can copy the
 * marker; review 2026-11-14). When the author cannot be told, nothing is
 * adopted and the answer is posted. A platform error throws so the broker retries.
 */
export class SkippedTriggerReplyPublisher {
    constructor(
        private readonly publications: PublicationStore,
        private readonly repositories: RepositoryResolver,
        private readonly codeManagement: CodeManagementPort,
        private readonly authors?: CommentAuthorPort,
        /** Kodus's address (API_FRONTEND_URL): the answer links to where its action is done. */
        private readonly dashboardUrl?: string,
    ) {}

    private linksFor(repositoryId: string): SkippedTriggerLinks {
        const { settings } = runtimeLinks(this.dashboardUrl, { runId: '', repositoryId });
        if (!settings) return {};
        return { settings, environments: `${settings.slice(0, settings.indexOf('/settings/code-review/'))}/runtime/environments` };
    }

    async answer(req: SkippedTriggerReplyRequest): Promise<SkippedTriggerReplyOutcome> {
        const line = renderSkippedTriggerReply(req.reason, req.setup, this.linksFor(req.repositoryId));
        if (!line) return { outcome: 'silent' };
        const headSha = req.headSha ?? NO_HEAD;
        // A setup that moves from "setting up" to "blocked" on the same head is a new answer.
        const key = skippedTriggerReplyKey({ ...req, headSha, reason: req.setup ? `${req.reason}:${req.setup}` : req.reason });
        const organizationAndTeamData = { organizationId: req.organizationId, teamId: req.teamId };
        const repository = await this.repositories.resolve(organizationAndTeamData, req.repositoryId);
        if (!repository) return { outcome: 'refused', reason: 'repository_not_in_org' };
        const platformType = await this.codeManagement.getTypeIntegration(organizationAndTeamData);
        if (!platformType) return { outcome: 'refused', reason: 'no_integration' };

        const claim = await this.publications.claim({
            key,
            runId: key,
            attempt: 0,
            kind: SKIPPED_TRIGGER_REPLY_KIND,
            organizationId: req.organizationId,
            teamId: req.teamId,
            repositoryId: req.repositoryId,
            prNumber: req.prNumber,
            headSha,
        });
        if (claim.state === 'duplicate') return { outcome: 'duplicate', key };
        if (claim.state === 'busy') throw new PublicationBusyError(key);

        const marker = skippedTriggerMarker(key);
        const target = { organizationAndTeamData, repository: { id: repository.id, name: repository.name }, prNumber: req.prNumber };
        try {
            const found = await this.findPosted(target, marker, platformType);
            if (found) {
                await this.publications.complete(key, { status: 'published', comment: found });
                return { outcome: 'published', key, action: 'found' };
            }
            const created = await this.codeManagement.createIssueComment({ ...target, body: `${line}\n\n${marker}` }, platformType);
            const comment = toPublishedCommentRef(created, platformType);
            if (!comment) throw new PublicationFailedError(key, 'the platform did not create the comment');
            await this.publications.complete(key, { status: 'published', comment });
            return { outcome: 'published', key, action: 'created' };
        } catch (error) {
            await this.publications.release(key, error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    /** The answer a delivery posted before its platform answer was lost, if any. */
    private async findPosted(
        target: { organizationAndTeamData: { organizationId: string; teamId: string }; repository: { id: string; name: string }; prNumber: number },
        marker: string,
        platformType: PlatformType,
    ): Promise<PublishedCommentRef | null> {
        const own = (await this.authors?.ownAuthor(target.organizationAndTeamData, platformType)) ?? null;
        if (!own) return null;
        const comments = await this.codeManagement.getAllCommentsInPullRequest({ ...target, failOnError: true }, platformType);
        const posted = (comments ?? []).find((c) => hasCommentMarker(c?.body, marker) && isOwnComment(c, own));
        return posted ? recoveredCommentRef(posted, platformType) : null;
    }
}
