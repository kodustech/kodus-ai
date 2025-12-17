import { Repository } from '@/config/types/general/codeReview.type';
import { Commit } from '@/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TreeItem } from '@/config/types/general/tree.type';
import {
    GitHubReaction,
    GitlabReaction,
} from '@/core/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { CodeManagementConnectionStatus } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import { IntegrationConfigEntity } from '../../integrationConfigs/entities/integration-config.entity';
import { GitCloneParams } from '../types/codeManagement/gitCloneParams.type';
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
import { Workflow } from '../types/codeManagement/workflow.type';
import { ICommonPlatformIntegrationService } from './common.interface';

export interface ICodeManagementService
    extends ICommonPlatformIntegrationService {
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
    getWorkflows(params: any): Promise<Workflow[]>;
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

    getUserByEmailOrName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        email?: string;
        userName: string;
    }): Promise<any>;

    getUserById(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        userId: string;
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
    }): Promise<any>;

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
        reaction: GitHubReaction | GitlabReaction;
    }): Promise<void>;

    addReactionToComment?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reaction: GitHubReaction | GitlabReaction;
    }): Promise<void>;

    removeReactionsFromPR?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reactions: (GitHubReaction | GitlabReaction)[];
    }): Promise<void>;

    removeReactionsFromComment?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reactions: (GitHubReaction | GitlabReaction)[];
    }): Promise<void>;
}
