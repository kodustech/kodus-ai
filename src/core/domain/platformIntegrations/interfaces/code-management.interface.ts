import { CommitLeadTimeForChange } from '../types/codeManagement/commitLeadTimeForChange.type';
import { DeployFrequency } from '../types/codeManagement/deployFrequency.type';
import { Organization } from '../types/codeManagement/organization.type';
import {
    PullRequestCodeReviewTime,
    PullRequestDetails,
    PullRequestReviewComment,
    PullRequests,
    PullRequestsWithChangesRequested,
    PullRequestWithFiles,
} from '../types/codeManagement/pullRequests.type';
import { Repositories } from '../types/codeManagement/repositories.type';
import { ICommonPlatformIntegrationService } from './common.interface';
import { IntegrationConfigEntity } from '../../integrationConfigs/entities/integration-config.entity';
import { Workflow } from '../types/codeManagement/workflow.type';
import { CodeManagementConnectionStatus } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { Repository, ReviewComment } from '@/config/types/general/codeReview.type';

export interface ICodeManagementService
    extends ICommonPlatformIntegrationService {
    getPullRequests(params: any): Promise<PullRequests[]>;
    getPullRequestDetails(params: any): Promise<PullRequestDetails | null>;
    getRepositories(params: any): Promise<Repositories[]>;
    getWorkflows(params: any): Promise<Workflow[]>;
    getListMembers(
        params: any,
    ): Promise<{ name: string; id: string | number }[]>;
    verifyConnection(params: any): Promise<CodeManagementConnectionStatus>;
    getCommitsByReleaseMode(params: any): Promise<CommitLeadTimeForChange[]>;
    getPullRequestsWithFiles(params): Promise<PullRequestWithFiles[] | null>;
    getPullRequestsForRTTM(params): Promise<PullRequestCodeReviewTime[] | null>;
    getCommits(params: any): Promise<any>;
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
    getRepositoryAllFiles(params: any): Promise<any>;
    cloneRepository(params: any): Promise<string>;
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

    markReviewCommentAsResolved(params: any): Promise<any | null>;
    getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Partial<Repository>,
        prNumber: number,
    }): Promise<PullRequestReviewComment[] | null>
    getPullRequestsByRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: {
            id: string;
            name: string;
        };
    }): Promise<any[]>;

    getPullRequestReviewThreads(params: {
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Partial<Repository>,
        prNumber: number,
    }): Promise<PullRequestReviewComment[] | null>

    getListOfValidReviews(params: {
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Partial<Repository>,
        prNumber: number,
    }): Promise<any[] | null>

    getPullRequestsWithChangesRequested(params: {
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Partial<Repository>,
    }): Promise<PullRequestsWithChangesRequested[] | null>

}
