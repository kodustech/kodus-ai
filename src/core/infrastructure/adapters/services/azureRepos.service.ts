import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PinoLoggerService } from './logger/pino.service';
import { CommitLeadTimeForChange } from '@/core/domain/platformIntegrations/types/codeManagement/commitLeadTimeForChange.type';
import { DeployFrequency } from '@/core/domain/platformIntegrations/types/codeManagement/deployFrequency.type';
import {
    PullRequests,
    PullRequestWithFiles,
    PullRequestCodeReviewTime,
    PullRequestFile,
    PullRequestDetails,
    PullRequestReviewComment,
    PullRequestsWithChangesRequested,
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { v4 as uuidv4, v4 } from 'uuid';
import { createTwoFilesPatch } from 'diff';

import * as moment from 'moment-timezone';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { PromptService } from './prompt.service';
import { Organization } from '@/core/domain/platformIntegrations/types/codeManagement/organization.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import { User } from '@/core/domain/platformIntegrations/types/projectManagement/user.type';
import { Commit } from '@/config/types/general/commit.type';
import { AxiosAzureReposService } from '@/config/axios/microservices/azureRepos.axios';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import { CodeManagementConnectionStatus } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { CreateAuthIntegrationStatus } from '@/shared/domain/enums/create-auth-integration-status.enum';
import { AuthMode } from '@/core/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { AzureReposAuthDetail } from '@/core/domain/authIntegrations/types/azure-repos-auth-detail';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import axios from 'axios';
import { AzureReposRequestHelper } from './azureRepos/azure-repos-request-helper';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { AzureGitPullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { Comment, FileChange } from '@/config/types/general/codeReview.type';
import {
    CommentResult,
    Repository,
    ReviewComment,
} from '@/config/types/general/codeReview.type';
import { IRepositoryManager } from '@/core/domain/repository/contracts/repository-manager.contract';
import { REPOSITORY_MANAGER_TOKEN } from '@/core/domain/repository/contracts/repository-manager.contract';
import { decrypt, encrypt } from '@/shared/utils/crypto';
import { generateWebhookToken } from '@/shared/utils/webhooks/webhookTokenCrypto';
import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import { Workflow } from '@/core/domain/platformIntegrations/types/codeManagement/workflow.type';
import { AzureRepoDiffChange, AzureRepoPRThread } from '@/core/domain/azureRepos/entities/azureRepoExtras.type';
import { getSeverityLevelShield } from '@/shared/utils/codeManagement/severityLevel';
import { getCodeReviewBadge } from '@/shared/utils/codeManagement/codeReviewBadge';
import { getLabelShield } from '@/shared/utils/codeManagement/labels';
import { getTranslationsForLanguageByCategory, TranslationsCategory } from '@/shared/utils/translations/translations';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';

interface FileDiff {
    filename: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    patch: string;
    additions: number;
    deletions: number;
    oldContent: string;
    newContent: string;
}

@IntegrationServiceDecorator(PlatformType.AZURE_REPOS, 'codeManagement')
export class AzureReposService
    implements Omit<ICodeManagementService, 'getOrganizations'> {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parameterService: IParametersService,

        @Inject(REPOSITORY_MANAGER_TOKEN)
        private readonly repositoryManager: IRepositoryManager,

        private readonly logger: PinoLoggerService,
        private readonly azureReposRequestHelper: AzureReposRequestHelper,
    ) { }

    getPullRequestDetails(params: any): Promise<PullRequestDetails | null> {
        throw new Error('Method not implemented.');
    }
    getWorkflows(params: any): Promise<Workflow[]> {
        throw new Error('Method not implemented.');
    }
    getListMembers(
        params: any,
    ): Promise<{ name: string; id: string | number }[]> {
        throw new Error('Method not implemented.');
    }
    getCommitsByReleaseMode(params: any): Promise<CommitLeadTimeForChange[]> {
        throw new Error('Method not implemented.');
    }
    getPullRequestsForRTTM(
        params: any,
    ): Promise<PullRequestCodeReviewTime[] | null> {
        throw new Error('Method not implemented.');
    }

    async getChangedFilesSinceLastCommit(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string; project: { id: string } };
        prNumber: number;
        lastCommit: { created_at: string };
    }): Promise<FileChange[] | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                lastCommit,
            } = params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const commits =
                await this.azureReposRequestHelper.getCommitsForPullRequest({
                    orgName,
                    token,
                    projectId: repository.project.id,
                    repositoryId: repository.id,
                    prId: prNumber,
                });

            const newCommits = commits.filter(
                (commit) =>
                    new Date(commit.author?.date).getTime() >
                    new Date(lastCommit.created_at).getTime(),
            );

            const changedFiles: FileChange[] = [];

            for (const commit of newCommits) {
                const changes =
                    await this.azureReposRequestHelper.getChangesForCommit({
                        orgName,
                        token,
                        projectId: repository.project.id,
                        repositoryId: repository.id,
                        commitId: commit.commitId,
                    });

                for (const change of changes) {
                    changedFiles.push({
                        filename: change.item.path,
                        sha: commit.commitId,
                        status: this.azureReposRequestHelper.mapAzureStatusToFileChangeStatus(
                            change.changeType,
                        ),
                        additions: 0,
                        deletions: 0,
                        changes: 0,
                        patch: null,
                        blob_url: null,
                        raw_url: null,
                        contents_url: null,
                        content: null,
                        previous_filename: null,
                        fileContent: null,
                        reviewMode: null,
                        codeReviewModelUsed: {
                            generateSuggestions: null,
                            safeguard: null,
                        },
                    });
                }
            }

            return changedFiles;
        } catch (error) {
            this.logger.error({
                message: `Error to get changed files since last commit for PR#${params.prNumber}`,
                context: this.getChangedFilesSinceLastCommit.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async createReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string; project: { id: string } };
        prNumber: number;
        lineComment: Comment;
        language: LanguageValue;
    }): Promise<AzureRepoPRThread | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, lineComment, language,
            } = params;
            const { orgName, token } = await this.getAuthDetails(organizationAndTeamData);

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const translations = getTranslationsForLanguageByCategory(
                language,
                TranslationsCategory.ReviewComment,
            );

            const bodyFormatted = this.formatBodyForGitHub(
                lineComment,
                repository,
                translations,
            );

            const thread = await this.azureReposRequestHelper.createReviewComment({
                orgName,
                token,
                projectId,
                repositoryId: repository.id,
                prId: prNumber,
                filePath: lineComment.path,
                start_line: lineComment.start_line,
                line: lineComment.line,
                commentContent: bodyFormatted,
            });

            return thread;
        } catch (error) {
            this.logger.error({
                message: `Error creating review comment for PR#${params.prNumber}`,
                context: 'AzureReposService',
                serviceName: 'createReviewComment',
                error,
                metadata: params,
            });
            return null;
        }
    }

    createCommentInPullRequest(params: any): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }
    async getRepositoryContentFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string; project: { id: string } };
        file: { filename: string };
        pullRequest: { number: number };
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, file, pullRequest } =
                params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const commits =
                await this.azureReposRequestHelper.getCommitsForPullRequest({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: pullRequest.number,
                });

            const latestCommit = commits[commits.length - 1]; // assume ordenação crescente

            if (!latestCommit?.commitId) {
                return null;
            }

            const content =
                await this.azureReposRequestHelper.getRepositoryContentFile({
                    orgName,
                    token,
                    projectId: projectId,
                    repositoryId: repository.id,
                    commitId: latestCommit.commitId,
                    filePath: file.filename,
                });

            return {
                data: {
                    content: content?.content ?? '',
                    encoding: 'utf-8',
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error to get repository content file',
                context: this.getRepositoryContentFile.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }
    async getPullRequestByNumber(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string; project: { id: string } };
        prNumber: number;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const pr = await this.azureReposRequestHelper.getPullRequestDetails(
                {
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                },
            );

            return pr;
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull request by number',
                context: this.getPullRequestByNumber.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }
    async getCommitsForPullRequestForCodeReview(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string; project: { id: string } };
        prNumber: number;
    }): Promise<any[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const commits =
                await this.azureReposRequestHelper.getCommitsForPullRequest({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                });

            return commits
                .map((commit) => ({
                    sha: commit.commitId,
                    message: commit.comment,
                    created_at: commit.author?.date,
                    author: {
                        name: commit.author?.name,
                        email: commit.author?.email,
                        date: commit.author?.date,
                        username: commit.author?.name, // Azure não separa "username" em campo próprio
                    },
                }))
                .sort(
                    (a, b) =>
                        new Date(b.created_at).getTime() -
                        new Date(a.created_at).getTime(),
                );
        } catch (error) {
            this.logger.error({
                message: 'Error to get commits for pull request for code review',
                context: this.getCommitsForPullRequestForCodeReview.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }
    async createIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        body: string;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, body } = params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const comment =
                await this.azureReposRequestHelper.createIssueComment({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                    comment: body,
                });

            if (!comment?.comments?.[0]?.id) {
                throw new Error(`Failed to create issue comment PR#${prNumber}`);
            }

            this.logger.log({
                message: `Created issue comment for PR#${prNumber}`,
                context: this.createIssueComment.name,
                metadata: { params },
            });

            return {
                ...comment,
                id: comment?.comments?.[0]?.id,
                threadId: comment.id,
            }
        } catch (error) {
            this.logger.error({
                message: 'Error to create issue comment',
                context: this.createIssueComment.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }
    createSingleIssueComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    async updateIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string; project: { id: string } };
        prNumber: number;
        commentId: number;
        body: string;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                commentId,
                body,
            } = params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const threads =
                await this.azureReposRequestHelper.getPullRequestComments({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                });

            const thread = threads.find(
                (thread) => thread.id === Number(commentId),
            );

            if (!thread) {
                throw new NotFoundException(
                    `Could not find thread #${thread}`,
                );
            }

            return await this.azureReposRequestHelper.updateCommentOnPullRequest(
                {
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prNumber,
                    threadId: Number(thread.id),
                    commentId,
                    content: body,
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error updating comment',
                context: this.updateIssueComment.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }
    findTeamAndOrganizationIdByConfigKey(
        params: any,
    ): Promise<IntegrationConfigEntity | null> {
        throw new Error('Method not implemented.');
    }
    async getDefaultBranch(params: any): Promise<string> {
        const { organizationAndTeamData, repository } = params;

        const { orgName, token } = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const projectId = await this.getProjectIdFromRepository(
            organizationAndTeamData,
            repository.id,
        );

        const defaultBranch =
            await this.azureReposRequestHelper.getDefaultBranch({
                orgName,
                token,
                projectId,
                repositoryId: repository.id,
            });

        return defaultBranch;
    }
    getPullRequestReviewComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    createResponseToComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    async updateDescriptionInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; project: { id: string } };
        prNumber: number;
        summary: string;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, summary } =
                params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const updatedPR =
                await this.azureReposRequestHelper.updatePullRequestDescription(
                    {
                        orgName,
                        token,
                        projectId,
                        repositoryId: repository.id,
                        prId: prNumber,
                        description: summary,
                    },
                );

            return updatedPR;
        } catch (error) {
            this.logger.error({
                message: `Error to update description in pull request #${params.prNumber}`,
                context: this.updateDescriptionInPullRequest.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }
    getAuthenticationOAuthToken(params: any): Promise<string> {
        throw new Error('Method not implemented.');
    }
    countReactions(params: any): Promise<any[]> {
        throw new Error('Method not implemented.');
    }
    async getLanguageRepository(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository } = params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const data =
                await this.azureReposRequestHelper.getLanguageRepository({
                    orgName,
                    token,
                    projectId,
                });

            const languages = data?.languageBreakdown ?? [];

            if (!languages?.length) {
                return '';
            }

            const main = languages.reduce((a, b) =>
                (b.languagePercentage ?? 0) > (a.languagePercentage ?? 0)
                    ? b
                    : a,
            );

            return main?.name ?? '';
        } catch (error) {
            this.logger.error({
                message: 'Error to get language repository',
                context: this.getLanguageRepository.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }

    getRepositoryAllFiles(params: any): Promise<any> {
        throw new Error('Method not implemented.');
    }
    mergePullRequest(params: any): Promise<any> {
        throw new Error('Method not implemented.');
    }
    approvePullRequest(params: any): Promise<any> {
        throw new Error('Method not implemented.');
    }
    requestChangesPullRequest(params: any): Promise<any> {
        throw new Error('Method not implemented.');
    }
    getAllCommentsInPullRequest(params: any): Promise<any[]> {
        throw new Error('Method not implemented.');
    }
    getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any> {
        throw new Error('Method not implemented.');
    }
    getUserByEmailOrName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        email?: string;
        userName: string;
    }): Promise<any> {
        throw new Error('Method not implemented.');
    }
    getUserById(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        userId: string;
    }): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    markReviewCommentAsResolved(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    async getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const comments =
                await this.azureReposRequestHelper.getPullRequestComments({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                });

            return comments
                .flatMap((thread) =>
                    (thread.comments || []).map((comment) => ({
                        id: comment.id,
                        threadId: String(thread.id),
                        body: comment.content ?? '',
                        createdAt: comment.publishedDate,
                        updatedAt: comment.lastUpdatedDate,
                        isResolved: thread.status === 'closed',
                        author: {
                            id: comment.author?.id,
                            username: comment.author?.displayName,
                            name: comment.author?.displayName,
                        },
                    })),
                )
                .filter(
                    (comment) =>
                        !comment.body.includes(
                            '## Code Review Completed! 🔥',
                        ) &&
                        !comment.body.includes(
                            '# Found critical issues please',
                        ),
                )
                .sort(
                    (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                );
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull request review comments',
                context: this.getPullRequestReviewComments.name,
                error,
                metadata: { params },
            });
            return null;
        }
    }
    getPullRequestReviewThreads(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        throw new Error('Method not implemented.');
    }
    getListOfValidReviews(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }
    getPullRequestsWithChangesRequested(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
    }): Promise<PullRequestsWithChangesRequested[] | null> {
        throw new Error('Method not implemented.');
    }

    async cloneRepository(params: {
        repository: Pick<
            Repository,
            'id' | 'defaultBranch' | 'fullName' | 'name'
        >;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<string> {
        try {
            const azureAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!azureAuthDetail) {
                throw new BadRequestException('Installation not found');
            }

            const repositories = await this.getRepositories({
                organizationAndTeamData: params.organizationAndTeamData,
            });

            const repository = repositories.find(
                (repo) => repo.id === params?.repository?.id,
            );

            if (!repository) {
                throw new BadRequestException('Repository not found');
            }

            const repoPath = await this.repositoryManager.gitCloneWithAuth({
                organizationId: params?.organizationAndTeamData?.organizationId,
                repositoryId: params?.repository?.id,
                repositoryName: params?.repository?.name,
                url: repository.http_url,
                branch: params?.repository?.defaultBranch,
                provider: PlatformType.AZURE_REPOS,
                auth: {
                    type: azureAuthDetail.authMode,
                    token: decrypt(azureAuthDetail.token),
                },
            });

            return repoPath;
        } catch (error) {
            this.logger.error({
                message: `Failed to clone repository ${params?.repository?.fullName} from Azure Repos`,
                context: this.cloneRepository.name,
                error: error,
                metadata: { params },
            });
            return '';
        }
    }

    async getAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<AzureReposAuthDetail> {
        try {
            const azureAuthDetail =
                await this.integrationService.getPlatformAuthDetails<AzureReposAuthDetail>(
                    organizationAndTeamData,
                    PlatformType.AZURE_REPOS,
                );

            return {
                ...azureAuthDetail,
                authMode: azureAuthDetail?.authMode || AuthMode.TOKEN,
            };
        } catch (err) {
            this.logger.error({
                message: 'Error to get auth details',
                context: this.getAuthDetails.name,
                error: err,
                metadata: {
                    organizationAndTeamData,
                },
            });
        }
    }

    async createWebhook(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        try {
            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projects = await this.azureReposRequestHelper.getProjects({
                orgName: azureAuthDetail.orgName,
                token: azureAuthDetail.token,
            });

            for (const project of projects) {
                await this.createNotificationChannel(
                    project.id,
                    azureAuthDetail.token,
                    azureAuthDetail.orgName,
                    project.id,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error to create webhook',
                context: this.createWebhook.name,
                error: error,
                metadata: {
                    organizationAndTeamData,
                },
            });
        }
    }

    async createAuthIntegration(params: any): Promise<any> {
        try {
            let res: {
                success: boolean;
                status?: CreateAuthIntegrationStatus;
            } = { success: true, status: CreateAuthIntegrationStatus.SUCCESS };
            if (params && params?.authMode === AuthMode.OAUTH) {
                throw new Error(
                    'Authenticating on Azure Devops Repos via OAuth not implemented',
                );
            } else if (
                params &&
                params?.authMode === AuthMode.TOKEN &&
                params.token
            ) {
                const res = await this.authenticateWithToken({
                    organizationAndTeamData: params.organizationAndTeamData,
                    token: params.token,
                    orgUrl: params.orgUrl,
                    orgName: params.orgName,
                });

                if (!res.success) {
                    throw new BadRequestException(res.status);
                }
            }

            return res;
        } catch (err) {
            this.logger.error({
                message: 'Error to create auth integration',
                context: this.createAuthIntegration.name,
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async authenticateWithToken(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        orgUrl: string;
        token: string;
        orgName: string;
    }): Promise<{ success: boolean; status?: CreateAuthIntegrationStatus }> {
        try {
            const { organizationAndTeamData, token, orgUrl, orgName } = params;

            const checkRepos = await this.checkRepositoryPermissions({
                token: token,
                orgUrl: orgUrl,
                orgName: orgName,
            });

            if (!checkRepos.success) return checkRepos;

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.AZURE_REPOS,
            });

            const authDetails: AzureReposAuthDetail = {
                orgUrl: orgUrl,
                token: encrypt(token),
                authMode: AuthMode.TOKEN,
                orgName: orgName,
            };

            await this.handleIntegration(
                integration,
                authDetails,
                organizationAndTeamData,
            );

            return {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
        } catch (err) {
            this.logger.error({
                message: 'Error to authenticate with token',
                context: this.authenticateWithToken.name,
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(
                'Error authenticating with Azure Devops PAT.',
            );
        }
    }

    private async checkRepositoryPermissions(params: {
        token: string;
        orgUrl: string;
        orgName: string;
    }) {
        try {
            const projects = await this.azureReposRequestHelper.getProjects({
                orgName: params.orgName,
                token: params.token,
            });

            const repositories = [];

            for (const project of projects) {
                const prjectRepositories =
                    await this.azureReposRequestHelper.getRepositories({
                        orgName: params.orgName,
                        token: params.token,
                        projectId: project.id,
                    });

                repositories.push(...prjectRepositories);
            }

            if (repositories.length === 0) {
                return {
                    success: false,
                    status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
                };
            }

            return {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to list repositories when creating integration',
                context: this.checkRepositoryPermissions.name,
                error: error,
                metadata: { params },
            });
            return {
                success: false,
                status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
            };
        }
    }

    async handleIntegration(
        integration: IntegrationEntity | null,
        authDetails: AzureReposAuthDetail,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        if (!integration) {
            await this.addAccessToken(organizationAndTeamData, authDetails);
        } else {
            await this.updateAuthIntegration({
                organizationAndTeamData,
                authIntegrationId: integration?.authIntegration?.uuid,
                integrationId: integration?.uuid,
                authDetails,
            });
        }
    }

    async addAccessToken(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails: AzureReposAuthDetail,
    ): Promise<IntegrationEntity> {
        const authUuid = v4();

        const authIntegration = await this.authIntegrationService.create({
            uuid: authUuid,
            status: true,
            authDetails,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        return await this.addIntegration(
            organizationAndTeamData,
            authIntegration?.uuid,
        );
    }

    async addIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
        authIntegrationId: string,
    ): Promise<IntegrationEntity> {
        const integrationUuid = v4();

        return await this.integrationService.create({
            uuid: integrationUuid,
            platform: PlatformType.AZURE_REPOS,
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            authIntegration: { uuid: authIntegrationId },
        });
    }

    async updateAuthIntegration(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: params.organizationAndTeamData.teamId,
                },
                platform: PlatformType.AZURE_REPOS,
            });

            if (!integration?.authIntegration?.uuid) {
                throw new NotFoundException('Integration not found');
            }

            const authIntegration = await this.authIntegrationService.findOne({
                uuid: integration?.authIntegration?.uuid,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: params.organizationAndTeamData.teamId,
                },
            });

            await this.authIntegrationService.update(
                { uuid: authIntegration?.uuid },
                {
                    authDetails: {
                        ...authIntegration?.authDetails,
                        organization: {
                            id:
                                params.authDetails.organization?.id ??
                                authIntegration?.authDetails?.organization?.id,
                            name:
                                params.authDetails.organization?.name ??
                                authIntegration?.authDetails?.organization
                                    ?.name,
                        },
                    },
                },
            );

            return {
                success: true,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error to update auth integration',
                context: this.updateAuthIntegration.name,
                error: error,
                metadata: { params },
            });
            return {
                success: false,
            };
        }
    }

    async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: params.organizationAndTeamData.teamId,
                },
                platform: PlatformType.AZURE_REPOS,
            });

            if (!integration) {
                return;
            }

            await this.integrationConfigService.createOrUpdateConfig(
                params.configKey,
                params.configValue,
                integration?.uuid,
                params.organizationAndTeamData,
            );

            this.createWebhook(params.organizationAndTeamData);
        } catch (err) {
            this.logger.error({
                message: 'Error to create or update integration config',
                context: this.createOrUpdateIntegrationConfig.name,
                error: err,
                metadata: { params },
            });
            throw new BadRequestException(err);
        }
    }

    async getPullRequestsByRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: {
            id: string;
            name: string;
        };
        filters?: {
            startDate: string;
            endDate: string;
        };
    }) {
        try {
            const { organizationAndTeamData, repository, filters } = params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            let queryString = '';
            if (filters?.startDate) {
                queryString += `created_on >= "${filters.startDate}"`;
            }
            if (filters?.endDate) {
                queryString += `${queryString ? ' AND ' : ''
                    }created_on <= "${filters.endDate}"`;
            }

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const pullRequests =
                await this.azureReposRequestHelper.getPullRequestsByRepo({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    startDate: filters?.startDate,
                    endDate: filters?.endDate,
                });

            return (
                pullRequests?.map((pr) =>
                    this.transformPullRequest(
                        pr,
                        repository.name,
                        organizationAndTeamData.organizationId,
                    ),
                ) || []
            );
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests by repository',
                context: this.getPullRequestsByRepository.name,
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async getPullRequests(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: {
            startDate?: string;
            endDate?: string;
            assignFilter?: any;
            state?: PullRequestState;
            includeChanges?: boolean;
            pullRequestNumbers?: number[];
        };
    }): Promise<PullRequests[]> {
        try {
            const { organizationAndTeamData, filters } = params;

            if (!organizationAndTeamData.organizationId) {
                return null;
            }

            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const { orgName, token } = azureAuthDetail;

            const repositories: Repositories[] =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );
            if (!repositories || repositories.length === 0) {
                return null;
            }

            let allPRs: any[] = [];

            const results = await Promise.all(
                repositories.map(async (repo) => {
                    const prs = await this.getPullRequestsByRepository({
                        organizationAndTeamData,
                        repository: {
                            id: repo.id,
                            name: repo.name,
                        },
                        filters: {
                            startDate: filters?.startDate,
                            endDate: filters?.endDate,
                        },
                    });

                    return prs?.map((item) => ({
                        ...item,
                        repository: repo.name,
                    }));
                }),
            );

            allPRs = results.flat();

            const stateMap: Record<string, PullRequestState> = {
                active: PullRequestState.OPENED,
                completed: PullRequestState.MERGED,
                abandoned: PullRequestState.CLOSED,
            };

            const transformed = allPRs.map((pr) => ({
                id: pr.pullRequestId?.toString(),
                author_id: pr.createdBy?.id,
                author_name: pr.createdBy?.displayName,
                author_created_at: pr.creationDate,
                repository: pr.repository,
                repositoryId: pr.repository
                    ? pr.repository.id
                    : pr.repositoryId,
                message: pr.description,
                state:
                    stateMap[pr.status?.toLowerCase()] ||
                    PullRequestState.ALL,
                prURL: pr._links?.web?.href,
                organizationId: organizationAndTeamData.organizationId,
                pull_number: pr.pullRequestId,
                number: pr.pullRequestId,
                body: pr.description,
                title: pr.title,
                created_at: pr.creationDate,
                updated_at:
                    pr.status === 'completed' || pr.status === 'abandoned'
                        ? pr.closedDate
                        : pr.creationDate,
                merged_at: pr.status === 'completed' ? pr.closedDate : null,
                participants: [],
                reviewers:
                    pr.reviewers?.map((reviewer) => ({
                        ...reviewer,
                        uuid: reviewer.id,
                    })) || [],
                head: {
                    ref: pr.sourceRefName?.replace('refs/heads/', ''),
                    repo: {
                        id: pr.repository?.id,
                        name: pr.repository?.name,
                    },
                },
                base: {
                    ref: pr.targetRefName?.replace('refs/heads/', ''),
                },
                user: {
                    login:
                        pr.createdBy?.uniqueName ||
                        pr.createdBy?.displayName ||
                        '',
                    name: pr.createdBy?.displayName,
                    id: pr.createdBy?.id,
                },
            }));

            let finalPRs = transformed;
            if (filters && filters.state) {
                finalPRs = finalPRs.filter((pr) => pr.state === filters.state);
            }

            finalPRs.sort(
                (a, b) =>
                    new Date(b.created_at).getTime() -
                    new Date(a.created_at).getTime(),
            );

            if (filters && filters.pullRequestNumbers) {
                finalPRs = finalPRs.filter((pr) =>
                    filters.pullRequestNumbers.includes(Number(pr.id)),
                );
            }

            return finalPRs;
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests',
                context: this.getPullRequests.name,
                error: error,
                metadata: { params },
            });
            return [];
        }
    }

    async getPullRequestsWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: { period?: { startDate?: string; endDate?: string } };
    }): Promise<PullRequestWithFiles[] | null> {
        try {
            const { organizationAndTeamData } = params;
            const filters = params.filters ?? {};
            const { startDate, endDate } = filters.period || {};

            const repositories: Repositories[] =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories || repositories.length === 0) {
                return null;
            }

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const reposWithPRs = await Promise.all(
                repositories.map(async (repo) => {
                    const prs =
                        await this.azureReposRequestHelper.getPullRequestsByRepo(
                            {
                                orgName,
                                token,
                                projectId: repo.project.id,
                                repositoryId: repo.id,
                                startDate,
                                endDate,
                            },
                        );
                    return { repo, prs };
                }),
            );

            const pullRequestsWithFiles: PullRequestWithFiles[] = [];

            await Promise.all(
                reposWithPRs.map(async ({ repo, prs }) => {
                    const prsWithDiffs = await Promise.all(
                        prs.map(async (pr) => {
                            const iterations =
                                await this.azureReposRequestHelper.getIterations(
                                    {
                                        orgName,
                                        token,
                                        projectId: repo.project.id,
                                        repositoryId: repo.id,
                                        prId: pr.pullRequestId,
                                    },
                                );

                            const lastIteration =
                                iterations[iterations.length - 1];

                            const iterationId = lastIteration.id;

                            const changes =
                                await this.azureReposRequestHelper.getChanges({
                                    orgName,
                                    token,
                                    projectId: repo.project.id,
                                    repositoryId: repo.id,
                                    pullRequestId: pr.pullRequestId,
                                    iterationId,
                                });

                            const diffs =
                                changes.map((change) => change.item) || [];
                            return { pr, diffs };
                        }),
                    );
                }),
            );

            return pullRequestsWithFiles;
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests with files',
                context: this.getPullRequestsWithFiles.name,
                error: error,
                metadata: { params },
            });
            return null;
        }
    }

    async getRepositories(params: any): Promise<Repositories[]> {
        try {
            const { organizationAndTeamData } = params;

            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!azureAuthDetail) {
                return [];
            }

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: organizationAndTeamData.teamId,
                },
                platform: PlatformType.AZURE_REPOS,
            });

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: organizationAndTeamData.teamId },
                });

            const projects = await this.azureReposRequestHelper.getProjects({
                orgName: azureAuthDetail.orgName,
                token: azureAuthDetail.token,
            });

            const projectsWithRepos = await Promise.all(
                projects.map(async (project) => {
                    const repositories =
                        await this.azureReposRequestHelper.getRepositories({
                            orgName: azureAuthDetail.orgName,
                            token: azureAuthDetail.token,
                            projectId: project.id,
                        });
                    return {
                        project,
                        repositories,
                    };
                }),
            );

            const repositories = projectsWithRepos.reduce<Repositories[]>(
                (acc, { project, repositories }) => {
                    repositories.forEach((repo) => {
                        acc.push(
                            this.transformRepo(
                                repo,
                                project,
                                integrationConfig,
                            ),
                        );
                    });
                    return acc;
                },
                [],
            );

            return repositories;
        } catch (error) {
            this.logger.error({
                message: 'Error to get repositories',
                context: AzureReposService.name,
                serviceName: 'AzureReposService getRepositories',
                error: error,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(error);
        }
    }

    private transformRepo(
        repo: any,
        project: any,
        integrationConfig: IntegrationConfigEntity,
    ): Repositories {
        return {
            id: repo.id,
            name: repo.name ?? '',
            http_url: repo.webUrl ?? '',
            avatar_url: '',
            organizationName: project.name ?? '',
            visibility: project.visibility === 'private' ? 'private' : 'public',
            selected:
                integrationConfig?.configValue?.some(
                    (repository) => repository?.name === repo.name,
                ) ?? false,
            default_branch: repo.defaultBranch ?? '',
            project: {
                id: project?.id,
                name: project?.name ?? '',
            },
        };
    }

    async getCommits(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: {
            startDate?: string;
            endDate?: string;
        };
    }): Promise<Commit[]> {
        try {
            const { organizationAndTeamData } = params;
            const filters = params.filters ?? {};
            const { startDate, endDate } = filters;

            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const { orgName, token } = azureAuthDetail;

            const repositories: Repositories[] =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );
            if (!repositories || repositories.length === 0) {
                return [];
            }

            const commitsByRepo = await Promise.all(
                repositories.map(async (repo) => {
                    return this.azureReposRequestHelper.getCommits({
                        orgName,
                        token,
                        projectId: repo.project.id,
                        repositoryId: repo.id,
                    });
                }),
            );

            const allCommits = commitsByRepo.flat();

            const filteredCommits = allCommits.filter((commit: any) => {
                const commitDate = new Date(commit.author?.date).getTime();
                const start = startDate ? new Date(startDate).getTime() : null;
                const end = endDate ? new Date(endDate).getTime() : null;
                return (
                    (!start || commitDate >= start) &&
                    (!end || commitDate <= end)
                );
            });

            const formattedCommits: Commit[] = filteredCommits.map(
                (commit: any) => {
                    return {
                        sha: commit.commitId,
                        commit: {
                            author: {
                                id: commit.author?.id || '',
                                name: commit.author?.name,
                                email: commit.author?.email,
                                date: commit.author?.date,
                            },
                            message: commit.comment,
                        },
                    };
                },
            );

            const sortedCommits = formattedCommits.sort(
                (a, b) =>
                    new Date(b.commit.author.date).getTime() -
                    new Date(a.commit.author.date).getTime(),
            );

            return sortedCommits;
        } catch (error) {
            this.logger.error({
                message: 'Error to get commits',
                context: this.getCommits.name,
                error: error,
                metadata: { params },
            });
            return [];
        }
    }

    async getFilesByPullRequestId(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        prNumber: number;
    }): Promise<FileChange[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const { orgName, token } = azureAuthDetail;

            // Use getRepoById for consistency, assuming it fetches necessary project info
            // const repo = await this.getRepoById(organizationAndTeamData, repository.id);
            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );
            if (!projectId) {
                this.logger.error({
                    message: `Repository or project details not found for ID: ${repository.id}`,
                    context: this.getFilesByPullRequestId.name,
                    metadata: { repositoryId: repository.id },
                });
                throw new NotFoundException(
                    `Repository or project details not found for ID: ${repository.id}`,
                );
            }

            // 1. Get PR details to find base and target commit refs
            const pr = await this.azureReposRequestHelper.getPullRequestDetails({
                orgName,
                token,
                projectId,
                repositoryId: repository.id,
                prId: prNumber,
            });

            // Use target branch commit as the base for comparison
            const baseCommitId = pr.lastMergeTargetCommit?.commitId;
            if (!baseCommitId) {
                this.logger.error({
                    message: `Could not determine the base commit (target branch commit) for PR #${prNumber}`,
                    context: this.getFilesByPullRequestId.name,
                    metadata: { prNumber, baseCommitId },
                });
                throw new NotFoundException(
                    `Could not determine the base commit for PR #${prNumber}`,
                );
            }
            this.logger.log({
                message: `Base commit for PR #${prNumber}: ${baseCommitId}`,
                context: this.getFilesByPullRequestId.name,
                metadata: { prNumber, baseCommitId },
            });

            // 2. Get Iterations to find the commit ID of the latest source changes
            const iterations = await this.azureReposRequestHelper.getIterations({
                orgName,
                token,
                projectId,
                repositoryId: repository.id,
                prId: prNumber,
            });

            if (!iterations || iterations.length === 0) {
                this.logger.warn({
                    message: `No iterations found for PR #${prNumber}. Returning empty list.`,
                    context: this.getFilesByPullRequestId.name,
                    metadata: { prNumber },
                });
                return [];
            }

            // Use the source commit from the PR details as the target for comparison
            const targetCommitId = pr.lastMergeSourceCommit?.commitId;
            const iterationId = iterations[iterations.length - 1].id; // Still need iteration ID for getChanges API

            if (!targetCommitId) {
                this.logger.error({
                    message: `Could not determine the target commit (source branch commit) for PR #${prNumber}`,
                    context: this.getFilesByPullRequestId.name,
                    metadata: { prNumber, targetCommitId },
                });
                throw new NotFoundException(
                    `Could not determine the target commit for PR #${prNumber}`,
                );
            }
            this.logger.log({
                message: `Target commit for PR #${prNumber}: ${targetCommitId}`,
                context: this.getFilesByPullRequestId.name,
                metadata: { prNumber, targetCommitId },
            });

            // 3. Get the list of changed files *in the last iteration* compared to its base (often the target branch base)
            // Note: The getChanges API might compare iteration N to iteration N-1 or to the common base.
            // We primarily use its output for the *list* of files changed in the *latest* iteration.
            // The diff generation below explicitly uses the determined baseCommitId and targetCommitId.
            const changesResponse = await this.azureReposRequestHelper.getChanges({
                orgName,
                token,
                projectId,
                repositoryId: repository.id,
                pullRequestId: prNumber,
                iterationId, // Get changes for the last iteration
                // compareIteration: Optional - consider if comparing explicitly to base (0) is needed here
            });

            // Ensure we have changeEntries which should be an array from the response
            const changeEntries = changesResponse || []; // Adjust based on actual response structure if 'changes' is nested
            this.logger.log({
                message: `Found ${changeEntries.length} change entries in iteration ${iterationId} for PR #${prNumber}`,
                context: this.getFilesByPullRequestId.name,
                metadata: { prNumber, iterationId, changeEntriesLength: changeEntries.length },
            });

            // 4. Process each change entry to generate the diff using our specific base and target commits
            const fileDiffPromises = changeEntries
                .filter((change) => change.item?.path) // Ensure item and path exist
                .map((change) => {
                    const filePath = change.item.path;
                    // Pass the globally determined base/target and the specific change type
                    return this._generateFileDiffForAzure({
                        orgName,
                        token,
                        projectId,
                        repositoryId: repository.id,
                        filePath,
                        baseCommitId, // Base commit of the target branch
                        targetCommitId, // Source commit of the PR
                        changeType: change.changeType,
                    });
                });

            const enrichedFilesResults = await Promise.all(fileDiffPromises);

            // Filter out any null results where diff generation failed
            const successfulFiles = enrichedFilesResults.filter(
                (file): file is NonNullable<typeof file> => file !== null,
            );

            this.logger.log({
                message: `Successfully generated diffs for ${successfulFiles.length} files for PR #${prNumber}`,
                context: this.getFilesByPullRequestId.name,
                metadata: { prNumber, successfulFilesLength: successfulFiles.length },
            });

            // Map to the expected FileChange format (ensure this matches your domain type)
            const fileChanges: FileChange[] = successfulFiles.map((file) => ({
                filename: file.filename,
                sha: file.sha, // SHA is often file hash, not commit ID. Reconsider if needed.
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch,
                content: file.content, // Added content
                blob_url: null, // Populate if needed/available
                raw_url: null, // Populate if needed/available
                contents_url: null, // Populate if needed/available
            }));

            return fileChanges;
        } catch (error: any) {
            this.logger.error({
                message: `Failed to get files for Azure Repos PR #${params.prNumber} in repo ${params.repository.name}`,
                context: this.getFilesByPullRequestId.name,
                error: error,
                metadata: { params },
            });
            // Rethrow or return null/empty based on desired error handling
            // throw error; // Or return null; depending on how you want to handle failures
            return null;
        }
    }

    private async _generateFileDiffForAzure(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filePath: string;
        baseCommitId: string | null; // Can be null for new files
        targetCommitId: string;
        changeType: string; // Azure's change type (e.g., 'add', 'edit', 'delete')
    }): Promise<{
        filename: string;
        sha: string; // Added missing sha property
        status: FileChange['status'];
        additions: number;
        deletions: number;
        changes: number;
        patch: string;
        content: string; // Added content
    } | null> {
        const {
            orgName,
            token,
            projectId,
            repositoryId,
            filePath,
            baseCommitId,
            targetCommitId,
            changeType,
        } = params;

        let originalFileContent = '';
        let modifiedFileContent = '';
        let patch = '';
        let additions = 0;
        let deletions = 0;
        const status: FileChange['status'] = // Use correct type from FileChange
            this.azureReposRequestHelper.mapAzureStatusToFileChangeStatus(
                changeType,
            );

        try {
            // Get original content (only if not an added file and baseCommitId exists)
            if (status !== 'added' && baseCommitId) {
                try {
                    const originalFile =
                        await this.azureReposRequestHelper.getFileContent({
                            orgName,
                            token,
                            projectId,
                            repositoryId,
                            filePath,
                            commitId: baseCommitId,
                        });
                    originalFileContent = originalFile.content;
                } catch (error: any) {
                    // Handle cases where the base file might not exist (e.g., renamed files treated as add/delete)
                    // Or if the commit doesn't contain the file path (shouldn't happen for 'edit'/'delete' if baseCommitId is correct)
                    if (error.status === 404) {
                        this.logger.warn({
                            message: `Original file content not found for path "${filePath}" at commit "${baseCommitId}". Treating as added file content for diff.`,
                            context: this._generateFileDiffForAzure.name,
                            metadata: { filePath, baseCommitId },
                        });
                        originalFileContent = ''; // Treat as empty for diff if base is not found
                    } else {
                        this.logger.error({
                            message: `Failed to get original file content for path "${filePath}" at commit "${baseCommitId}"`,
                            context: this._generateFileDiffForAzure.name,
                            error: error,
                            metadata: { filePath, baseCommitId },
                        });
                        throw error; // Rethrow other errors
                    }
                }
            }

            // Get modified content (only if not a deleted file)
            if (status !== 'removed') { // Compare with 'removed'
                try {
                    const modifiedFile =
                        await this.azureReposRequestHelper.getFileContent({
                            orgName,
                            token,
                            projectId,
                            repositoryId,
                            filePath,
                            commitId: targetCommitId,
                        });
                    modifiedFileContent = modifiedFile.content;
                } catch (error: any) {
                    if (error.status === 404) {
                        // This might happen if the file was deleted in the target commit, but the status wasn't 'delete' initially.
                        this.logger.warn({
                            message: `Modified file content not found for path "${filePath}" at commit "${targetCommitId}". Treating as deleted file content for diff.`,
                            context: this._generateFileDiffForAzure.name,
                            metadata: { filePath, targetCommitId },
                        });
                        modifiedFileContent = ''; // Treat as empty if modified not found
                    } else {
                        this.logger.error({
                            message: `Failed to get modified file content for path "${filePath}" at commit "${targetCommitId}"`,
                            context: this._generateFileDiffForAzure.name,
                            error: error,
                            metadata: { filePath, targetCommitId },
                        });
                        throw error; // Rethrow other errors
                    }
                }
            }

            // Generate unified diff only if we have something to compare
            if (originalFileContent || modifiedFileContent) {
                patch = createTwoFilesPatch(
                    status === 'renamed' // Compare with string literal
                        ? params.filePath /* Use original path here if available and needed */
                        : filePath, // Adjust if original path is needed for renamed files
                    filePath,
                    originalFileContent,
                    modifiedFileContent,
                    baseCommitId ?? '',
                    targetCommitId,
                    { context: 3 }, // Context lines around changes
                );

                // Calculate additions and deletions from the patch
                const diffLines = patch.split('\n');
                additions = diffLines.filter(
                    (line) => line.startsWith('+') && !line.startsWith('+++'),
                ).length;
                deletions = diffLines.filter(
                    (line) => line.startsWith('-') && !line.startsWith('---'),
                ).length;
            } else if (status === 'removed') { // Compare with 'removed'
                // Handle deleted files explicitly if needed (e.g., create a dummy patch or specific log)
                patch = `--- a/${filePath}\n+++ /dev/null\n File deleted`; // Example dummy patch
                deletions = 0; // Or calculate based on original file lines if fetched
            } else if (status === 'added') { // Compare with string literal
                // Handle added files explicitly if needed
                patch = `--- /dev/null\n+++ b/${filePath}\n File added`; // Example dummy patch
                additions = 0; // Or calculate based on modified file lines if fetched
            }

            return {
                filename: filePath,
                sha: targetCommitId, // SHA is often file hash, not commit ID. Reconsider if needed.
                status,
                additions,
                deletions,
                changes: additions + deletions,
                patch,
                content: modifiedFileContent, // Added content
            };
        } catch (error: any) {
            this.logger.error({
                message: `Error generating diff for file "${filePath}" between commits "${baseCommitId}" and "${targetCommitId}"`,
                context: this._generateFileDiffForAzure.name,
                error: error,
                metadata: { filePath, baseCommitId, targetCommitId },
            });
            return null; // Return null to indicate failure for this specific file
        }
    }

    private transformPullRequest(
        pr: any,
        repository: string,
        organizationId: string,
    ): PullRequests & any {
        const stateMap: Record<AzureGitPullRequestState, PullRequestState> = {
            [AzureGitPullRequestState.ACTIVE]: PullRequestState.OPENED,
            [AzureGitPullRequestState.COMPLETED]: PullRequestState.MERGED,
            [AzureGitPullRequestState.ABANDONED]: PullRequestState.CLOSED,
        };

        return {
            id: pr.pullRequestId?.toString(),
            author_id: pr.createdBy?.id,
            author_name: pr.createdBy?.displayName,
            author_created_at: pr.creationDate,
            repository,
            repositoryId: pr.repository?.id,
            message: pr.description,
            state:
                stateMap[pr.status as AzureGitPullRequestState] ||
                PullRequestState.ALL,
            prURL: pr._links?.web?.href,
            organizationId,
            pull_number: pr.pullRequestId,
            number: pr.pullRequestId,
            body: pr.description,
            title: pr.title,
            created_at: pr.creationDate,
            updated_at:
                pr.status === 'completed' || pr.status === 'abandoned'
                    ? pr.closedDate
                    : pr.creationDate,
            merged_at: pr.status === 'completed' ? pr.closedDate : null,
            participants: [],
            reviewers:
                pr.reviewers?.map((reviewer) => ({
                    ...reviewer,
                    uuid: reviewer.id,
                })) || [],
            head: {
                ref: pr.sourceRefName?.replace('refs/heads/', ''),
                repo: {
                    id: pr.repository?.id,
                    name: pr.repository?.name,
                },
            },
            base: {
                ref: pr.targetRefName?.replace('refs/heads/', ''),
            },
            user: {
                login:
                    pr.createdBy?.uniqueName ||
                    pr.createdBy?.displayName ||
                    '',
                name: pr.createdBy?.displayName,
                id: pr.createdBy?.id,
            },
        };
    }

    private async getProjectIdFromRepository(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<string | null> {
        const repositories = <Repositories[]>(
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            )
        );

        if (!repositories) {
            return null;
        }

        const repo = repositories.find((repo) => repo.id === repositoryId);

        return repo.project.id || null;
    }

    private async getRepoById(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<Repositories | null> {
        const repositories = <Repositories[]>(
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            )
        );

        if (!repositories) {
            return null;
        }

        return repositories.find((repo) => repo.id === repositoryId);
    }

    private extractDiffStatsFromPatch(patch: string): {
        additions: number;
        deletions: number;
        patch: string;
    } {
        const lines = patch.split('\n');
        let additions = 0;
        let deletions = 0;

        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                additions++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                deletions++;
            }
        }

        return {
            additions,
            deletions,
            patch,
        };
    }

    async verifyConnection(
        params: any,
    ): Promise<CodeManagementConnectionStatus> {
        try {
            if (!params.organizationAndTeamData.organizationId) {
                return {
                    platformName: PlatformType.AZURE_REPOS,
                    isSetupComplete: false,
                    hasConnection: false,
                    config: {},
                };
            }

            const [azureReposRepositories, azureReposOrg] = await Promise.all([
                this.findOneByOrganizationIdAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                ),
                this.integrationService.findOne({
                    organization: {
                        uuid: params.organizationAndTeamData.organizationId,
                    },
                    team: {
                        uuid: params.organizationAndTeamData.teamId,
                    },
                    platform: PlatformType.AZURE_REPOS,
                }),
            ]);

            const hasRepositories = azureReposRepositories?.length > 0;

            return {
                platformName: PlatformType.AZURE_REPOS,
                isSetupComplete:
                    azureReposOrg?.authIntegration?.authDetails?.token &&
                    azureReposOrg?.authIntegration?.authDetails?.orgName &&
                    hasRepositories,
                hasConnection: !!azureReposOrg,
                config: {
                    hasRepositories: hasRepositories,
                },
                category: IntegrationCategory.CODE_MANAGEMENT,
            };
        } catch (err) {
            this.logger.error({
                message: 'Error to verify connection',
                context: this.verifyConnection.name,
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async findOneByOrganizationIdAndConfigKey(
        organizationAndTeamData: OrganizationAndTeamData,
        configKey: IntegrationConfigKey.REPOSITORIES,
    ): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                platform: PlatformType.AZURE_REPOS,
            });

            if (!integration) {
                return;
            }

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    team: { uuid: organizationAndTeamData.teamId },
                    configKey,
                });

            return integrationConfig?.configValue || null;
        } catch (err) {
            this.logger.error({
                message: 'Error to find one by organization and team data',
                error: err,
                context: this.findOneByOrganizationIdAndConfigKey.name,
            });
            throw new BadRequestException(err);
        }
    }

    async findOneByOrganizationAndTeamDataAndConfigKey(
        organizationAndTeamData: OrganizationAndTeamData,
        configKey:
            | IntegrationConfigKey.INSTALLATION_GITHUB
            | IntegrationConfigKey.REPOSITORIES,
    ): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.AZURE_REPOS,
            });

            if (!integration) return;

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    team: { uuid: organizationAndTeamData.teamId },
                    configKey,
                });

            return integrationConfig?.configValue || null;
        } catch (err) {
            this.logger.error({
                message: 'Error to find one by organization and team data',
                error: err,
                context: this.findOneByOrganizationAndTeamDataAndConfigKey.name,
            });
            throw new BadRequestException(err);
        }
    }

    private async createNotificationChannel(
        projectId: string,
        userToken: string,
        organizationName: string,
        repoId: string,
    ): Promise<void> {
        const eventTypes = [
            'git.pullrequest.created',
            'git.pullrequest.updated',
            'ms.vss-code.git-pullrequest-comment-event',
        ];
        const webhookUrl =
            process.env.GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK;
        const encryptedToken = generateWebhookToken();

        const tasks = eventTypes.map(async (eventType) => {
            const payload = {
                publisherId: 'tfs',
                eventType,
                resourceVersion: '2.0',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                    projectId,
                    repository: repoId, // Ensure this is correct for Azure DevOps API
                },
                consumerInputs: {
                    url: `${webhookUrl}?token=${encodeURIComponent(encryptedToken)}`,
                },
            };

            try {
                const existingHooks =
                    await this.azureReposRequestHelper.listSubscriptionsByProject(
                        {
                            orgName: organizationName,
                            token: userToken,
                            projectId,
                        },
                    );

                const alreadyExists = existingHooks.find(
                    (sub) =>
                        sub.eventType === eventType &&
                        sub.publisherInputs?.repository === repoId && // Check repoId here
                        sub.consumerInputs?.url?.includes(webhookUrl),
                );

                if (alreadyExists) {
                    this.logger.log({
                        message: `Webhook already exists for ${eventType}, id: ${alreadyExists.id}, will be removed`,
                        context: this.createNotificationChannel.name,
                        metadata: { eventType, webhookId: alreadyExists.id },
                    });

                    await this.azureReposRequestHelper.deleteWebhookById({
                        orgName: organizationName,
                        token: userToken,
                        subscriptionId: alreadyExists.id,
                    });
                }

                const created =
                    await this.azureReposRequestHelper.createSubscriptionForProject(
                        {
                            orgName: organizationName,
                            token: userToken,
                            projectId,
                            subscriptionPayload: payload,
                        },
                    );

                this.logger.log({
                    message: `Webhook created for ${eventType}, subscriptionId: ${created?.id}`,
                    context: this.createNotificationChannel.name,
                    metadata: { eventType, subscriptionId: created?.id },
                });
            } catch (error) {
                this.logger.error({
                    message: `Error creating webhook for event ${eventType}`,
                    context: this.createNotificationChannel.name,
                    error: error,
                    metadata: { eventType },
                });
            }
        });

        const results = await Promise.allSettled(tasks);

        results.forEach((res, idx) => {
            const evt = eventTypes[idx];
            if (res.status === 'rejected') {
                this.logger.error({
                    message: `Error final in processing ${evt}`,
                    context: this.createNotificationChannel.name,
                    error: res.reason,
                    metadata: { eventType: evt },
                });
            }
        });
    }

    private formatCodeBlock(language: string, code: string) {
        return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    private formatSub(text: string) {
        return `<sub>${text}</sub>\n\n`;
    }

    private formatBodyForGitHub(lineComment: any, repository: any, translations: any) {
        const severityShield = lineComment?.suggestion
            ? getSeverityLevelShield(lineComment.suggestion.severity)
            : '';
        const codeBlock = this.formatCodeBlock(
            repository?.language?.toLowerCase(),
            lineComment?.body?.improvedCode,
        );
        const suggestionContent = lineComment?.body?.suggestionContent || '';
        const actionStatement = lineComment?.body?.actionStatement
            ? `${lineComment.body.actionStatement}\n\n`
            : '';

        const badges = [
            getCodeReviewBadge(),
            lineComment?.suggestion
                ? getLabelShield(lineComment.suggestion.label)
                : '',
            severityShield,
        ].join(' ');

        return [
            badges,
            codeBlock,
            suggestionContent,
            actionStatement,
            this.formatSub(translations.talkToKody),
            this.formatSub(translations.feedback) +
            '<!-- kody-codereview -->&#8203;\n&#8203;',
        ]
            .join('\n')
            .trim();
    }
}
