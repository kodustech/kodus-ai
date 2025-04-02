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
