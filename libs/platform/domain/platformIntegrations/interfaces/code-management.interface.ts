import { Reaction } from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { Repository } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { TreeItem } from '@libs/core/infrastructure/config/types/general/tree.type';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { GitCloneParams } from '../types/codeManagement/gitCloneParams.type';
import {
    CodeManagementIssue,
    GetIssueParams,
    ListIssuesParams,
} from '../types/codeManagement/issues.type';
import { Organization } from '../types/codeManagement/organization.type';
import {
    PullRequest,
    PullRequestAuthor,
    PullRequestCodeReviewTime,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequestsWithChangesRequested,
    PullRequestWithFiles,
} from '../types/codeManagement/pullRequests.type';
import { Repositories } from '../types/codeManagement/repositories.type';
import { RepositoryFile } from '../types/codeManagement/repositoryFile.type';
import { ICommonPlatformIntegrationService } from './common.interface';

type GitActor = {
    name: string;
    email?: string;
};

export type PullRequestFileChange = {
    path: string;
    content?: string;
    operation?: 'upsert' | 'delete';
};

export type CodeManagementConnectionStatus = {
    hasConnection: boolean; // Whether there is a connection with the tool (e.g., GitHub)
    isSetupComplete: boolean; // Whether the tool is configured (e.g., repositories)
    config?: object;
    platformName: string;
    category?: IntegrationCategory;
};

export interface ICodeManagementService extends ICommonPlatformIntegrationService {
    /**
     * Read the host's native issue tracker. Optional: implemented per provider
     * as the generic issues MCP rolls out (GitHub first). The facade throws a
     * clear error for platforms that don't implement it yet.
     */
    listIssues?(params: ListIssuesParams): Promise<CodeManagementIssue[]>;
    getIssue?(params: GetIssueParams): Promise<CodeManagementIssue | null>;
    /**
     * Optional refinement of issue support beyond "the method exists" — e.g.
     * Bitbucket implements `listIssues` but Data Center/Server has no issue
     * tracker, so it returns false there.
     */
    supportsIssues?(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean>;

    findRepositoryByName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        name: string;
    }): Promise<Partial<Repository> | null>;
    createPullRequestWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        sourceBranch?: string;
        targetBranch?: string;
        baseBranch?: string;
        title?: string;
        description?: string;
        commitMessage?: string;
        author?: GitActor;
        files: PullRequestFileChange[];
    }): Promise<Partial<PullRequest> | null>;
    uploadFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        branchName?: string;
        baseBranch?: string;
        files: PullRequestFileChange[];
        message?: string;
        author?: GitActor;
    }): Promise<boolean>;

    getPullRequests(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: {
            id: string;
            name: string;
        };
        filters?: {
            startDate?: Date;
            endDate?: Date;
            state?: PullRequestState;
            author?: string;
            branch?: string;
        };
    }): Promise<PullRequest[]>;
    getPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequest | null>;
    getRepositories(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: {
            archived?: boolean;
            organizationSelected?: string;
            visibility?: 'all' | 'public' | 'private';
            language?: string;
        };
        options?: {
            includePullRequestMetrics?: {
                lastNDays?: number;
                limit?: number;
            };
        };
    }): Promise<Repositories[]>;
    getListMembers(
        params: any,
    ): Promise<{ name: string; id: string | number }[]>;
    verifyConnection(params: any): Promise<CodeManagementConnectionStatus>;
    getPullRequestsWithFiles(params): Promise<PullRequestWithFiles[] | null>;
    getPullRequestsForRTTM(params): Promise<PullRequestCodeReviewTime[] | null>;
    getCommits(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: Partial<Repository>;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            author?: string;
            branch?: string;
        };
    }): Promise<Commit[]>;
    getOrganizations(params: any): Promise<Organization[]>;

    getFilesByPullRequestId(params): Promise<any[] | null>;
    getChangedFilesSinceLastCommit(params: any): Promise<any | null>;
    createReviewComment(params: any): Promise<any | null>;
    createCommentInPullRequest(params): Promise<any[] | null>;
    getRepositoryContentFile(params: any): Promise<any | null>;

    /**
     * Batch-fetch file contents in a single round-trip. Implementations
     * that support it (GitHub via GraphQL aliasing) return a Map keyed
     * by filename. Adapters without a batch capability return `null` —
     * callers fall back to per-file `getRepositoryContentFile`.
     */
    getRepositoryContentBatch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: any };
        files: Array<{ filename: string; sha?: string }>;
        pullRequest?: any;
    }): Promise<Map<string, any> | null>;

    getPullRequestByNumber(params: any): Promise<any | null>;

    getCommitsForPullRequestForCodeReview(params: any): Promise<any[] | null>;
    createIssueComment(params: any): Promise<any | null>;
    createSingleIssueComment(params: any): Promise<any | null>;
    updateIssueComment(params: any): Promise<any | null>;
    minimizeComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        commentId: string;
        reason?:
            | 'ABUSE'
            | 'OFF_TOPIC'
            | 'OUTDATED'
            | 'RESOLVED'
            | 'DUPLICATE'
            | 'SPAM';
    }): Promise<any | null>;

    findTeamAndOrganizationIdByConfigKey(
        params: any,
    ): Promise<IntegrationConfigEntity | null>;
    getDefaultBranch(params: any): Promise<string>;
    getPullRequestReviewComment(params: any): Promise<any | null>;
    createResponseToComment(params: any): Promise<any | null>;
    updateDescriptionInPullRequest(params: any): Promise<any | null>;
    getAuthenticationOAuthToken(params: any): Promise<string>;
    countReactions(params: any): Promise<any[]>;
    getLanguageRepository(params: any): Promise<any | null>;
    getRepositoryAllFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: {
            id: string;
            name: string;
        };
        filters?: {
            branch?: string;
            filePatterns?: string[];
            excludePatterns?: string[];
            maxFiles?: number;
        };
    }): Promise<RepositoryFile[]>;
    getCloneParams(params: any): Promise<GitCloneParams>;
    mergePullRequest(params: any): Promise<any>;
    approvePullRequest(params: any): Promise<any>;
    requestChangesPullRequest(params: any): Promise<any>;

    getAllCommentsInPullRequest(params: any): Promise<any[]>;

    getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any>;

    /**
     * Batch-fetch user data by login in a single round-trip. Pre-warms
     * the cache used by `getUserByUsername`. Implementations that
     * support it (GitHub via GraphQL aliasing) return a Map keyed by
     * normalized login. Adapters without a batch capability return
     * `null` — callers fall back to per-user `getUserByUsername`.
     */
    getUsersByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        usernames: string[];
    }): Promise<Map<string, any> | null>;

    getUserByEmailOrName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        email?: string;
        userName: string;
    }): Promise<any>;

    getUserById(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        userId: string;
    }): Promise<any | null>;

    /**
     * Resolves the real PR/MR author from a webhook payload when the payload
     * itself does not carry an enriched author object. Currently only GitLab
     * needs this — other providers expose the author directly in `mapUsers`.
     */
    resolveMrAuthorFromWebhookPayload?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        payload: any;
    }): Promise<any | null>;

    getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null>;

    markReviewCommentAsResolved(params: any): Promise<any | null>;
    getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null>;
    getPullRequestsByRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: {
            id: string;
            name: string;
        };
    }): Promise<any[]>;

    getPullRequestReviewThreads(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null>;

    getListOfValidReviews(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any[] | null>;

    getPullRequestsWithChangesRequested(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
    }): Promise<PullRequestsWithChangesRequested[] | null>;

    getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        determineBots?: boolean;
    }): Promise<PullRequestAuthor[]>;

    checkIfPullRequestShouldBeApproved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }): Promise<any | null>;

    deleteWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void>;

    isWebhookActive(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<boolean>;

    formatReviewCommentBody(params: {
        suggestion: any;
        repository: { name: string; language: string };
        includeHeader?: boolean;
        includeFooter?: boolean;
        language?: string;
        organizationAndTeamData: OrganizationAndTeamData;
        suggestionCopyPrompt?: boolean;
    }): Promise<string>;

    getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<TreeItem[]>;

    getRepositoryTreeByDirectory(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        directoryPath?: string;
    }): Promise<TreeItem[]>;

    updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        parentId: string;
        commentId: string;
        body: string;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any | null>;

    isDraftPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<boolean>;

    getReviewStatusByPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewState | null>;

    addReactionToPR?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reaction: Reaction;
    }): Promise<void>;

    addReactionToComment?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reaction: Reaction;
    }): Promise<void>;

    removeReactionsFromPR?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reactions: Reaction[];
    }): Promise<void>;

    removeReactionsFromComment?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reactions: Reaction[];
    }): Promise<void>;
}
