import type { SuggestionResolver } from '../domain/runtime-publish.ports';

interface StoredSuggestion {
    id?: string;
    comment?: { id?: number };
}

interface StoredPullRequest {
    number: number;
    organizationId: string;
    repository?: { id?: string };
    files?: Array<{ suggestions?: StoredSuggestion[] }>;
}

/**
 * The product's review records, as the product's pull requests repository
 * hands them out (IPullRequestsRepository.getNativeCollection): the review
 * itself is product data in the product's store, not a Runtime store.
 */
export interface StoredPullRequests {
    findOne(filter: Record<string, unknown>, options: { projection: Record<string, 0 | 1> }): Promise<StoredPullRequest | null>;
}

/**
 * The review comment of a suggestion, read from the product's own record of
 * the review (`pullRequests`), scoped to the stored org, repo and PR. Only a
 * suggestion Kody delivered as a comment has an id to reply to.
 */
export class PullRequestSuggestionResolver implements SuggestionResolver {
    constructor(private readonly collection: StoredPullRequests) {}

    async resolve(input: Parameters<SuggestionResolver['resolve']>[0]) {
        const pr = await this.collection.findOne(
            {
                'number': input.prNumber,
                'organizationId':
                    input.organizationAndTeamData.organizationId,
                'repository.id': input.repositoryId,
                'files.suggestions.id': input.suggestionId,
            },
            { projection: { _id: 0, 'files.suggestions.id': 1, 'files.suggestions.comment.id': 1 } },
        );
        const suggestion = pr?.files
            ?.flatMap((f) => f.suggestions ?? [])
            .find((s) => s.id === input.suggestionId);
        const commentId = suggestion?.comment?.id;
        return typeof commentId === 'number' && Number.isSafeInteger(commentId)
            ? { commentId }
            : null;
    }
}
