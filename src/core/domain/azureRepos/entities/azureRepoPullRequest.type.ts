import { AzureReposRepository } from './azureReposRepository.type';

export interface AzureRepoIdentity {
    displayName: string;
    url: string;
    _links: {
        avatar: {
            href: string;
        };
    };
    id: string;
    uniqueName: string;
    imageUrl: string;
    descriptor: string;
}

export interface AzureRepoCommitRef {
    commitId: string;
    url: string;
}

export interface AzureRepoPullRequest {
    repository: Partial<AzureReposRepository>;
    pullRequestId: number;
    codeReviewId: number;
    status: string;
    createdBy: AzureRepoIdentity;
    creationDate: string;
    title: string;
    description: string;
    sourceRefName: string;
    targetRefName: string;
    mergeStatus: string;
    isDraft: boolean;
    mergeId: string;
    lastMergeSourceCommit: AzureRepoCommitRef;
    lastMergeTargetCommit: AzureRepoCommitRef;
    lastMergeCommit: AzureRepoCommitRef;
    reviewers: AzureRepoIdentity[];
    url: string;
    supportsIterations: boolean;
} 