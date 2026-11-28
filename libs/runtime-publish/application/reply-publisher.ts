import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { RuntimePublishRequested } from '@libs/runtime/run';

import { renderSuggestionReply, runtimeLinks } from '../domain/render-runtime-comment';
import type { PublicationStore } from '../domain/runtime-publication';
import type { CodeManagementPort, SuggestionResolver } from '../domain/runtime-publish.ports';
import { toPublishedCommentRef } from './comment-publisher';
import { PublicationFailedError, type PublishTarget } from './publication-outcome';

/** The replies on the review suggestions a Run reproduced, one publication each. */
export class ReplyPublisher {
    constructor(
        private readonly publications: PublicationStore,
        private readonly codeManagement: CodeManagementPort,
        private readonly suggestions: SuggestionResolver | undefined,
        private readonly dashboardUrl: string | undefined,
    ) {}

    /**
     * The replies on the review suggestions this Run reproduced (screen 7),
     * one key each. Best effort per suggestion: a suggestion the product
     * does not know on this PR, or a platform without threaded replies, is
     * skipped; a platform or lookup error throws so the broker retries the leftovers.
     */
    async publish(
        msg: RuntimePublishRequested,
        target: PublishTarget,
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
        const links = runtimeLinks(this.dashboardUrl, { runId: msg.runId, repositoryId: scope.repositoryId });
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
            let suggestion: { commentId: number } | null;
            try {
                suggestion = await this.suggestions.resolve({
                    organizationAndTeamData,
                    repositoryId: scope.repositoryId,
                    prNumber: scope.prNumber,
                    suggestionId,
                });
            } catch {
                // A lookup that failed is not "not found": the claim goes back and the broker retries it.
                await this.publications.release(key, 'the suggestion lookup failed');
                throw new PublicationFailedError(key, 'the suggestion lookup failed');
            }
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
}
