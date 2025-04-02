import {
    ClusteringType,
    ReviewModeResponse,
} from '@/config/types/general/codeReview.type';
import { DeliveryStatus } from '../enums/deliveryStatus.enum';
import { ImplementationStatus } from '../enums/implementationStatus.enum';
import { PriorityStatus } from '../enums/priorityStatus.enum';
import { FeedbackType } from '@/ee/kodyFineTuning/domain/enums/feedbackType.enum';

export interface IPullRequests {
    uuid?: string;
    title: string;
    status: string;
    merged: boolean;
    number: number;
    url: string;
    baseBranchRef: string;
    headBranchRef: string;
    repository: IRepository;
    openedAt: string;
    closedAt: string;
    files: IFile[];
    totalAdded?: number;
    totalDeleted?: number;
    totalChanges?: number;
    createdAt: string;
    updatedAt: string;
    provider: string;
    user: IPullRequestUser;
    reviewers?: IPullRequestUser[];
    assignees?: IPullRequestUser[];
    organizationId?: string;
    commits: ICommit[];
    syncedEmbeddedSuggestions?: boolean;
}

export interface ICommit {
    author: {
        id?: string;
        username?: string;
        name: string;
        email: string;
        date: string;
    };
    sha: string;
    message: string;
    createdAt: string;
}
export interface IRepository {
    id: string;
    name: string;
    fullName: string;
    language: string;
    url: string;
    createdAt: string;
    updatedAt: string;
}

export interface ISuggestion {
    id: string;
    relevantFile: string;
    language: string;
    suggestionContent: string;
    existingCode: string;
    improvedCode: string;
    oneSentenceSummary: string;
    relevantLinesStart: number;
    relevantLinesEnd: number;
    label: string;
    severity: string;
    rankScore?: number;
    brokenKodyRulesIds?: string[];
    clusteringInformation?: {
        type?: ClusteringType;
        relatedSuggestionsIds?: string[];
        parentSuggestionId?: string;
        problemDescription?: string;
        actionStatement?: string;
    };
    priorityStatus: PriorityStatus;
    deliveryStatus: DeliveryStatus;
    implementationStatus?: ImplementationStatus;
    comment?: {
        id: number;
        pullRequestReviewId: number;
    };
    createdAt: string;
    updatedAt: string;
}

export interface ISuggestionToEmbed {
    id?: string;
    improvedCode?: string;
    suggestionContent?: string;
    suggestionEmbed?: number[];
    oneSentenceSummary?: string;
    severity?: string;
    label?: string;
    implementationStatus?: ImplementationStatus;
    feedbackType?: FeedbackType | string;
    organizationId: string;
    relevantFile?: string;
    language?: string;
    existingCode?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    rankScore?: number;
    priorityStatus?: PriorityStatus;
    deliveryStatus?: DeliveryStatus;
    comment?: {
        id: number;
        pullRequestReviewId: number;
    };
    pullRequest: {
        number: number;
        repository: {
            id: string;
            fullName: string;
        };
    };
}

export interface IFile {
    id: string;
    sha?: string;
    path: string;
    filename: string;
    previousName: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    suggestions: ISuggestion[];
    added?: number;
    deleted?: number;
    changes?: number;
    reviewMode?: ReviewModeResponse;
    codeReviewModelUsed?: {
        generateSuggestions: string;
        safeguard: string;
    };
}

export interface IPullRequestUser {
    id: string;
    name?: string;
    email?: string;
    username: string;
}
