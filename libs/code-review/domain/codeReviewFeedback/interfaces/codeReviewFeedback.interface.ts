export interface ICodeReviewFeedback {
    uuid: string;
    organizationId: string;
    reactions: {
        thumbsUp: number;
        thumbsDown: number;
    };
    comment: {
        id: number;
        pullRequestReviewId?: string;
    };
    suggestionId: string;
    pullRequest: {
        id: string;
        number: number;
        repository: {
            id: string;
            fullName: string;
        };
    };
    syncedEmbeddedSuggestions: boolean;
}

/**
 * A reaction read from the git provider but not yet persisted — the shape
 * `GetReactionsUseCase` produces and `SaveCodeReviewFeedbackUseCase` stores.
 */
export type ICollectedReaction = Omit<
    ICodeReviewFeedback,
    'uuid' | 'syncedEmbeddedSuggestions'
>;
