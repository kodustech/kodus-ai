import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { Repository } from '@libs/core/infrastructure/config/types/general/codeReview.type';

export type PullRequest = {
    id: string;
    number: number;
    pull_number: number; // TODO: remove, legacy, use number
    body: string;
    /** Live provider labels; absent when the host does not support them. */
    labels?: string[];
    title: string;
    message: string;
    state: PullRequestState;
    organizationId: string;
    repository: string; // TODO: remove, legacy, use repositoryData
    repositoryId: string; // TODO: remove, legacy, use repositoryData
    repositoryData: {
        // TODO: consider removing this, use HEAD and BASE instead
        id: string;
        name: string;
    };
    prURL: string;
    created_at: string;
    closed_at: string;
    updated_at: string;
    merged_at: string;
    participants: {
        id: string;
    }[];
    reviewers: {
        id: string;
    }[];
    sourceRefName: string; // TODO: remove, legacy, use head.ref
    head: {
        ref: string;
        sha?: string;
        repo: {
            id: string;
            name: string;
            defaultBranch: string;
            fullName: string;
        };
    };
    targetRefName: string; // TODO: remove, legacy, use base.ref
    base: {
        ref: string;
        sha?: string;
        repo: {
            id: string;
            name: string;
            defaultBranch: string;
            fullName: string;
        };
    };
    user: {
        login: string;
        name: string;
        id: string;
    };
    isDraft: boolean;
};

export type PullRequestFile = {
    additions?: number;
    changes: number;
    deletions?: number;
    status?: string;
};

export type PullRequestCodeReviewTime = {
    id: number;
    created_at: string;
    closed_at: string;
};

export type PullRequestWithFiles = {
    id: number;
    pull_number: number;
    state: string;
    title: string;
    repository: string | { id: string; name: string };
    repositoryData?: Repository;
    pullRequestFiles: PullRequestFile[] | null;
};

export type PullRequestReviewComment = {
    id: string | number;
    threadId?: string;
    fullDatabaseId?: string; // only needed on github to handle different ids due to graphQL API
    isResolved?: boolean;
    isOutdated?: boolean;
    body: string;
    author?: {
        id?: string | number;
        name?: string;
        username?: string;
    };
    createdAt?: string;
    updatedAt?: string;
};

export type ReactionsInComments = {
    reactions: {
        thumbsUp: number;
        thumbsDown: number;
    };
    comment: {
        id: string;
        body: string;
        pull_request_review_id: string;
    };
    pullRequest: {
        id: string;
        number: number;
        repository: {
            id: string;
            fullName: string;
        };
    };
};

export type PullRequestsWithChangesRequested = {
    title: string;
    number: number;
    reviewDecision: PullRequestReviewState;
};

// For now it's only relevant for github
export enum PullRequestReviewState {
    COMMENTED = 'COMMENTED',
    PENDING = 'PENDING',
    APPROVED = 'APPROVED',
    CHANGES_REQUESTED = 'CHANGES_REQUESTED',
    DISMISSED = 'DISMISSED',
}

export type OneSentenceSummaryItem = {
    id?: number;
    oneSentenceSummary: string;
};

export type PullRequestAuthor = {
    id: string;
    name: string;
    contributions?: number;
    type?: string;
};

export type AuthorContributions = {
    [key: string]: {
        id: number;
        name: string;
        count: number;
    };
};
