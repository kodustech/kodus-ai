import {
    ClusteringType,
    ReviewModeResponse,
    SuggestionType,
} from '@libs/core/domain/enums/code-review.enum';

import { DeliveryStatus } from '../enums/deliveryStatus.enum';
import { ImplementationStatus } from '../enums/implementationStatus.enum';
import { PriorityStatus } from '../enums/priorityStatus.enum';
import { FeedbackType } from '@libs/kodyFineTuning/domain/enums/feedbackType.enum';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { LabelType } from '@libs/common/utils/codeManagement/labels';

// Per-PR delivered-suggestion counts, plus a breakdown of the SENT ones by
// severity. Powers the "needs attention" signal + severity filter on the PR
// dashboard list. Keys are the lowercased SeverityLevel values.
export type SuggestionSeverityBreakdown = Record<
    'critical' | 'high' | 'medium' | 'low',
    number
>;

export interface SuggestionCountsBySeverity {
    // deliveryStatus === 'sent' — comment posted on the PR.
    sent: number;
    // deliveryStatus === 'not_sent' — held back by the review config/priority
    // rules (severity threshold, quantity limit, safeguard, clustering…).
    filtered: number;
    // deliveryStatus ∈ {'failed', 'failed_lines_mismatch'} — Kody tried to post
    // but couldn't (API error / lines no longer match the diff). A delivery
    // failure, NOT a config decision — kept separate so it isn't hidden.
    failed: number;
    // deliveryStatus === 'replaced' — superseded by a newer suggestion (e.g. a
    // re-review). Counted for reconciliation; not surfaced as a live signal.
    replaced: number;
    // Delivered (sent) suggestions the author still hasn't applied —
    // implementationStatus ≠ 'implemented' (not_implemented, partially, or a
    // legacy doc with no status). This is the "Needs attention" signal: it must
    // match the card count (countDeliveredPullRequests unresolvedOnly) so the
    // list you see on click can't disagree with the badge.
    unresolved: number;
    // Same unresolved set, broken down by severity — lets the UI lead with
    // critical/high (the urgent slice) without hiding the lower-severity tail.
    unresolvedBySeverity: SuggestionSeverityBreakdown;
    bySeverity: SuggestionSeverityBreakdown;
    // Distinct labels (categories) among the delivered suggestions, lowercased.
    categories: string[];
}

export interface IPullRequests {
    uuid?: string;
    title: string;
    status: string;
    merged: boolean;
    /** Whether the last review ran in HEAVY mode (resolved post feature-gate). */
    heavy?: boolean;
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
    syncedWithIssues?: boolean;
    suggestionsByPR?: ISuggestionByPR[];
    prLevelSuggestions?: ISuggestionByPR[];
    isDraft: boolean;
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
    type?: SuggestionType;
    createdAt: string;
    updatedAt: string;
    prNumber?: number;
    prTitle?: string;
    prUrl?: string;
    repositoryId?: string;
    repositoryFullName?: string;
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

export interface ISuggestionByPR {
    id: string;
    suggestionContent: string;
    oneSentenceSummary: string;
    label: LabelType;
    severity?: SeverityLevel;
    brokenKodyRulesIds?: string[];
    priorityStatus?: PriorityStatus;
    deliveryStatus: DeliveryStatus;
    comment?: {
        id: number;
        pullRequestReviewId: number;
    };
    files?: {
        violatedFileSha?: string[];
        relatedFileSha?: string[];
    };
    createdAt?: string;
    updatedAt?: string;
}

export interface IDeliveredSuggestion {
    id: string;
    deliveryStatus: DeliveryStatus;
    comment: {
        id: number | string;
        pullRequestReviewId: number | null;
    };
}

export interface IPullRequestWithDeliveredSuggestions {
    _id: string;
    number: number;
    organizationId: string;
    status: string;
    provider: string;
    repository: {
        id: string;
        name: string;
    };
    suggestions: IDeliveredSuggestion[];
}

/**
 * Minimal PR data for token usage by developer queries.
 * Only contains fields needed to map PR numbers to developers.
 */
export interface IPullRequestUserMapping {
    number: number;
    user: IPullRequestUser;
    organizationId: string;
}
