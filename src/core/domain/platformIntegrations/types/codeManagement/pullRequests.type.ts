import { Repository } from '@/config/types/general/codeReview.type';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { RestEndpointMethodTypes } from '@octokit/rest';

export type PullRequestDetails =
    RestEndpointMethodTypes['pulls']['get']['response']['data'];

export type PullRequests = {
    id: string;
    author_id: string;
    author_name: string;
    message: string;
    created_at?: string;
    closed_at?: string;
    targetRefName?: string;
    sourceRefName?: string;
    state: PullRequestState;
    organizationId?: string;
    pull_number?: number;
    repository?: string;
    repositoryId?: string;
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
    repository: string;
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
    }
    createdAt?: string;
    updatedAt?: string;
}

export type PullRequestsWithChangesRequested = {
    title: string;
    number: number;
    reviewDecision: PullRequestReviewState;
}

// For now it's only relevant for github
export enum PullRequestReviewState {
    COMMENTED = "COMMENTED",
    PENDING = "PENDING",
    APPROVED = "APPROVED",
    CHANGES_REQUESTED = "CHANGES_REQUESTED",
    DISMISSED = "DISMISSED"
}

export type OneSentenceSummaryItem = {
    id?: number;
    oneSentenceSummary: string;
}
