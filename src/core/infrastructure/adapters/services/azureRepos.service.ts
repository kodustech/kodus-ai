import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    OneSentenceSummaryItem,
    PullRequest,
    PullRequestAuthor,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequestWithFiles,
    ReactionsInComments,
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { BadRequestException, Inject, NotFoundException } from '@nestjs/common';
import { createTwoFilesPatch } from 'diff';
import { v4 } from 'uuid';
import { PinoLoggerService } from './logger/pino.service';

import {
    Comment,
    CommentResult,
    FileChange,
    Repository,
} from '@/config/types/general/codeReview.type';
import { Commit } from '@/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TreeItem } from '@/config/types/general/tree.type';
import { AzureReposAuthDetail } from '@/core/domain/authIntegrations/types/azure-repos-auth-detail';
import {
    AzurePullRequestVote,
    AzureRepoCommit,
    AzureRepoFileItem,
    AzureRepoPRThread,
    EventConfig,
} from '@/core/domain/azureRepos/entities/azureRepoExtras.type';
import {
    AzurePRStatus,
    AzureRepoPullRequest,
} from '@/core/domain/azureRepos/entities/azureRepoPullRequest.type';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import { AuthMode } from '@/core/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import { GitCloneParams } from '@/core/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
import { RepositoryFile } from '@/core/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import { CreateAuthIntegrationStatus } from '@/shared/domain/enums/create-auth-integration-status.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { hasKodyMarker } from '@/shared/utils/codeManagement/codeCommentMarkers';
import { getCodeReviewBadge } from '@/shared/utils/codeManagement/codeReviewBadge';
import { getLabelShield } from '@/shared/utils/codeManagement/labels';
import { getSeverityLevelShield } from '@/shared/utils/codeManagement/severityLevel';
import { decrypt, encrypt } from '@/shared/utils/crypto';
import { CodeManagementConnectionStatus } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@/shared/utils/glob-utils';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@/shared/utils/translations/translations';
import { generateWebhookToken } from '@/shared/utils/webhooks/webhookTokenCrypto';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { MCPManagerService } from '../mcp/services/mcp-manager.service';
import { AzureReposRequestHelper } from './azureRepos/azure-repos-request-helper';

@IntegrationServiceDecorator(PlatformType.AZURE_REPOS, 'codeManagement')
export class AzureReposService
    implements
        Omit<
            ICodeManagementService,
            | 'getOrganizations'
            | 'getWorkflows'
            | 'getCommitsByReleaseMode'
            | 'getPullRequestsForRTTM'
            | 'getPullRequestReviewThreads'
            | 'getListOfValidReviews'
            | 'getPullRequestsWithChangesRequested'
            | 'getAuthenticationOAuthToken'
            | 'mergePullRequest'
            | 'getUserById'
        >
{
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        private readonly logger: PinoLoggerService,
        private readonly azureReposRequestHelper: AzureReposRequestHelper,
        private readonly configService: ConfigService,
        private readonly mcpManagerService?: MCPManagerService,
    ) {}

    async getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<PullRequestAuthor[]> {
        try {
            const { organizationAndTeamData } = params;

            if (!organizationAndTeamData.organizationId) {
                return [];
            }

            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const repositories: Repositories[] =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (
                !repositories ||
                repositories.length === 0 ||
                !azureAuthDetail
            ) {
                return [];
            }

            const since = new Date();
            since.setDate(since.getDate() - 60);

            const authorsSet = new Set<string>();
            const authorsData = new Map<string, PullRequestAuthor>();

            // Busca paralela otimizada
            const repoPromises = repositories.map(async (repo) => {
                try {
                    const prs = await this.getPullRequestsByRepository({
                        organizationAndTeamData,
                        repository: {
                            id: repo.id,
                            name: repo.name,
                        },
                        filters: {
                            startDate: since.toISOString(),
                            endDate: new Date().toISOString(),
                        },
                    });

                    // Para na primeira contribuição de cada usuário
                    for (const pr of prs || []) {
                        if (pr.user && pr.user.id) {
                            const userId = pr.user.id.toString();

                            if (!authorsSet.has(userId)) {
                                authorsSet.add(userId);
                                authorsData.set(userId, {
                                    id: userId,
                                    name:
                                        pr.user.name ??
                                        pr.user.login ??
                                        pr.user.id,
                                    type: 'user',
                                });
                            }
                        }
                    }
                } catch (error) {
                    this.logger.error({
                        message: 'Error in getPullRequestAuthors',
                        context: 'AzureService',
                        error: error,
                        metadata: {
                            organizationAndTeamData,
                            repositoryId: repo.id,
                        },
                    });
                }
            });

            await Promise.all(repoPromises);

            return Array.from(authorsData.values()).sort((a, b) =>
                a.name.localeCompare(b.name),
            );
        } catch (err) {
            this.logger.error({
                message: 'Error in getPullRequestAuthors',
                context: 'AzureService',
                error: err,
                metadata: {
                    organizationAndTeamData: params?.organizationAndTeamData,
                },
            });
            return [];
        }
    }
    async getListMembers(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<{ name: string; id: string | number }[]> {
        try {
            const organizationAndTeamData = params?.organizationAndTeamData;

            if (!organizationAndTeamData?.organizationId) {
                return [];
            }

            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetails?.orgName || !authDetails?.token) {
                return [];
            }

            const members =
                await this.azureReposRequestHelper.listOrganizationUsers({
                    orgName: authDetails.orgName,
                    token: authDetails.token,
                });

            if (!members || members.length === 0) {
                return [];
            }

            const normalizedMembers = members
                .map((member) => {
                    const id =
                        member?.descriptor ??
                        member?.originId ??
                        member?.principalName ??
                        member?.mailAddress;
                    const name =
                        member?.displayName ??
                        member?.principalName ??
                        member?.mailAddress ??
                        member?.originId ??
                        id;

                    if (!id || !name) {
                        return null;
                    }

                    return {
                        name,
                        id,
                        type: 'user',
                    };
                })
                .filter(
                    (
                        member,
                    ): member is {
                        name: string;
                        id: string | number;
                        type: string;
                    } => Boolean(member),
                );

            return normalizedMembers;
        } catch (error) {
            this.logger.error({
                message: 'Error to get Azure DevOps members',
                context: AzureReposService.name,
                serviceName: 'AzureReposService getListMembers',
                error,
                metadata: {
                    organizationAndTeamData: params?.organizationAndTeamData,
                },
            });
            return [];
        }
    }
    async createResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        prNumber: number;
        body: string;
        threadId: number;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                body,
                threadId,
            } = params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const response =
                await this.azureReposRequestHelper.replyToThreadComment({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                    threadId,
                    comment: body,
                });

            return response;
        } catch (error) {
            this.logger.error({
                message: 'Error creating response to pull request comment',
                context: AzureReposService.name,
                serviceName: 'AzureReposService createResponseToComment',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async findTeamAndOrganizationIdByConfigKey(
        params: any,
    ): Promise<IntegrationConfigEntity | null> {
        try {
            const integrationConfig =
                await this.integrationConfigService.findOne({
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    configValue: [{ id: params?.repository?.id?.toString() }],
                });

            return integrationConfig &&
                integrationConfig?.configValue?.length > 0
                ? integrationConfig
                : null;
        } catch (err) {
            this.logger.error({
                message: 'Error to find team and organization id by config key',
                context: AzureReposService.name,
                serviceName:
                    'AzureReposService findTeamAndOrganizationIdByConfigKey',
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async markReviewCommentAsResolved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        prNumber: number;
        commentId: number;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, commentId } =
                params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const response =
                await this.azureReposRequestHelper.resolvePullRequestThread({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                    threadId: commentId,
                });

            this.logger.log({
                message: `Marked thread ${commentId} as resolved in PR #${prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService markReviewCommentAsResolved',
                metadata: { params },
            });

            return response;
        } catch (error) {
            this.logger.error({
                message: `Failed to resolve review thread in PR #${params.prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService markReviewCommentAsResolved',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async getReviewStatusByPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewState | null> {
        const { organizationAndTeamData, repository, prNumber } = params;
        try {
            if (
                !organizationAndTeamData ||
                !repository ||
                !repository.id ||
                !repository.name ||
                !prNumber
            ) {
                this.logger.warn({
                    message:
                        'Missing required parameters to get review status by pull request',
                    context: AzureReposService.name,
                    serviceName:
                        'AzureReposService getReviewStatusByPullRequest',
                    metadata: {
                        repository: params.repository,
                        prNumber: params.prNumber,
                    },
                });
                return null;
            }

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const [currentUserId, reviewers] = await Promise.all([
                this.azureReposRequestHelper.getAuthenticatedUserId({
                    orgName,
                    token,
                }),
                this.azureReposRequestHelper.getListOfPullRequestReviewers({
                    orgName,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                    token,
                }),
            ]);

            if (!currentUserId) {
                this.logger.warn({
                    message: 'Could not identify current user from token.',
                    context: AzureReposService.name,
                    serviceName:
                        'AzureReposService getReviewStatusByPullRequest',
                    metadata: { params },
                });
                return null;
            }

            let state: PullRequestReviewState | null = null;
            for (const reviewer of reviewers || []) {
                if (
                    reviewer.id === currentUserId &&
                    reviewer.vote > AzurePullRequestVote.NoVote
                ) {
                    state = PullRequestReviewState.APPROVED;
                    break;
                }

                if (
                    reviewer.id === currentUserId &&
                    reviewer.vote === AzurePullRequestVote.Rejected
                ) {
                    state = PullRequestReviewState.CHANGES_REQUESTED;
                    break;
                }
            }

            return state;
        } catch (error) {
            this.logger.error({
                message: `Error fetching review status for PR #${prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService getReviewStatusByPullRequest',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async checkIfPullRequestShouldBeApproved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }): Promise<any | null> {
        const { organizationAndTeamData, prNumber, repository } = params;
        try {
            const reviewStatus =
                await this.getReviewStatusByPullRequest(params);

            if (reviewStatus === PullRequestReviewState.APPROVED) {
                this.logger.log({
                    message: `Pull request #${params.prNumber} already approved by this user.`,
                    context: AzureReposService.name,
                    serviceName:
                        'AzureReposService checkIfPullRequestShouldBeApproved',
                    metadata: { params },
                });
                return null;
            }

            const result = await this.approvePullRequest({
                organizationAndTeamData,
                prNumber,
                repository,
            });

            return result;
        } catch (error) {
            this.logger.error({
                message: `Error approving pull request #${params.prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService approvePullRequest',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async approvePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }): Promise<any> {
        try {
            const { organizationAndTeamData, prNumber, repository } = params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const reviewerId =
                await this.azureReposRequestHelper.getAuthenticatedUserId({
                    orgName,
                    token,
                });

            if (!reviewerId) {
                throw new Error('Unable to identify reviewer from PAT.');
            }

            const result = await this.azureReposRequestHelper.votePullRequest({
                orgName,
                token,
                projectId,
                repositoryId: repository.id,
                prId: prNumber,
                reviewerId,
                vote: AzurePullRequestVote.Approved, // approve
            });

            this.logger.log({
                message: `Approved pull request #${prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService approvePullRequest',
                metadata: { params },
            });

            return result;
        } catch (error) {
            this.logger.error({
                message: `Error approving pull request #${params.prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService approvePullRequest',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async requestChangesPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
        criticalComments: CommentResult[];
    }): Promise<any> {
        try {
            const {
                organizationAndTeamData,
                prNumber,
                repository,
                criticalComments,
            } = params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const reviewerId =
                await this.azureReposRequestHelper.getAuthenticatedUserId({
                    orgName,
                    token,
                });

            if (!reviewerId) {
                throw new Error('Unable to identify reviewer from PAT.');
            }

            await this.azureReposRequestHelper.votePullRequest({
                orgName,
                token,
                projectId,
                repositoryId: repository.id,
                prId: prNumber,
                reviewerId,
                vote: AzurePullRequestVote.Rejected, // request changes
            });

            const title =
                '# Found critical issues, please review the requested changes';
            const listOfCriticalIssues =
                this.getListOfCriticalIssues(criticalComments);

            const bodyFormatted = `${title}\n\n${listOfCriticalIssues}\n\n\n`;

            await this.createSingleIssueComment({
                body: bodyFormatted,
                organizationAndTeamData,
                prNumber,
                repository,
            });

            this.logger.log({
                message: `Requested changes on pull request #${prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService requestChangesPullRequest',
                metadata: { params },
            });

            return true;
        } catch (error) {
            this.logger.error({
                message: `Error requesting changes on pull request #${params.prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService requestChangesPullRequest',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async createSingleIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string };
        prNumber: number;
        body: string;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, body } =
                params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const response =
                await this.azureReposRequestHelper.createIssueComment({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                    comment: body,
                });

            return response;
        } catch (error) {
            this.logger.error({
                message: 'Failed to create single issue comment',
                context: AzureReposService.name,
                serviceName: 'AzureReposService createSingleIssueComment',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async getPullRequestReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: {
            repository: { id: string };
            pullRequestNumber: number;
        };
    }): Promise<any[] | null> {
        try {
            const { organizationAndTeamData, filters } = params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                filters.repository.id,
            );

            const threads =
                await this.azureReposRequestHelper.getPullRequestComments({
                    orgName,
                    token,
                    projectId,
                    repositoryId: filters.repository.id,
                    prId: filters.pullRequestNumber,
                });

            if (!threads?.length) {
                return [];
            }

            const comments = threads?.flatMap((thread) => {
                const commitId =
                    thread.pullRequestThreadContext?.commitId ?? null;

                return (thread.comments ?? [])
                    ?.filter((note) => !!note.content?.trim())
                    ?.map((note) => ({
                        id: note.id,
                        threadId: thread.id,
                        commentType: note?.commentType,
                        body: note.content,
                        createdAt: note.publishedDate,
                        originalCommit: commitId,
                        isResolved:
                            thread?.status === 'closed' ||
                            thread?.status === 'fixed',
                        author: {
                            id: note.author?.id,
                            username: note.author?.uniqueName,
                            name: note.author?.displayName,
                        },
                    }));
            });

            // Group comments by threadId
            const groupedComments = comments.reduce((acc, comment) => {
                if (!acc[comment.threadId]) {
                    acc[comment.threadId] = [];
                }
                acc[comment.threadId].push(comment);

                return acc;
            }, {});

            // Creates final comment array with replies
            const commentsWithReplyArray = Object.values(
                groupedComments,
            ).flatMap((group: any) => {
                // Sort Comments by created_at
                group.sort(
                    (a, b) =>
                        new Date(a.createdAt).getTime() -
                        new Date(b.createdAt).getTime(),
                );

                // The first comment of the sorted group will be the parent
                const parentComment = {
                    ...group[0],
                    replies: [],
                };

                // The rest are replies
                parentComment.replies = group.slice(1);

                return parentComment;
            });

            return commentsWithReplyArray.sort(
                (a, b) =>
                    new Date(b.createdAt).getTime() -
                    new Date(a.createdAt).getTime(),
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to get pull request review comment',
                context: AzureReposService.name,
                serviceName: 'AzureReposService getPullRequestReviewComment',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async getAllCommentsInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
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

            const threads =
                await this.azureReposRequestHelper.getPullRequestComments({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                });

            if (!threads?.length) {
                return [];
            }

            const comments = threads?.flatMap((thread) => {
                const commitId =
                    thread.pullRequestThreadContext?.commitId ?? null;

                return (thread.comments ?? [])
                    ?.filter((note) => !!note.content?.trim())
                    ?.map((note) => ({
                        id: note.id,
                        threadId: thread.id,
                        commentType: note?.commentType,
                        body: note.content,
                        createdAt: note.publishedDate,
                        isResolved:
                            thread?.status === 'closed' ||
                            thread?.status === 'fixed',
                        originalCommit: commitId,
                        author: {
                            id: note.author?.id,
                            username: note.author?.uniqueName,
                            name: note.author?.displayName,
                        },
                    }));
            });

            return comments;
        } catch (error) {
            this.logger.error({
                message: 'Failed to get all comments in pull request',
                context: AzureReposService.name,
                serviceName: 'AzureReposService',
                error,
                metadata: { params },
            });
            return null;
        }
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
                message: 'Failed to get language repository',
                context: AzureReposService.name,
                serviceName: 'AzureReposService',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    async getChangedFilesSinceLastCommit(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string; project: { id: string } };
        prNumber: number;
        lastCommit: any;
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
            const projectId = repository.project.id;

            // Obter detalhes do PR
            const pr = await this.azureReposRequestHelper.getPullRequestDetails(
                {
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                },
            );

            const targetCommitId = pr.lastMergeSourceCommit?.commitId;

            if (!targetCommitId) {
                this.logger.error({
                    message: `Não foi possível determinar o commit alvo para o PR #${prNumber}`,
                    context: this.getChangedFilesSinceLastCommit.name,
                    metadata: { prNumber, targetCommitId },
                });
                return null;
            }

            // Obter o diff entre lastCommit e targetCommitId
            const diffResponse = await this.azureReposRequestHelper.getDiff({
                orgName,
                token,
                projectId,
                repositoryId: repository.id,
                baseCommit: lastCommit.sha,
                targetCommitId,
            });

            const fileChanges = diffResponse?.filter(
                (change) => change?.item?.gitObjectType === 'blob',
            );

            if (!fileChanges?.length) {
                return null;
            }

            const changedFiles: FileChange[] = [];

            for (const change of fileChanges) {
                const filePath = change.item?.path;
                if (!filePath) continue;

                const fileDiff = await this._generateFileDiffForAzure({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    filePath,
                    baseCommitId: lastCommit.sha,
                    targetCommitId,
                    changeType: change.changeType,
                });

                if (fileDiff) {
                    changedFiles.push({
                        filename: fileDiff.filename,
                        sha: fileDiff.sha,
                        status: fileDiff.status,
                        additions: fileDiff.additions,
                        deletions: fileDiff.deletions,
                        changes: fileDiff.changes,
                        patch: fileDiff.patch,
                        content: fileDiff.content,
                        blob_url: null,
                        raw_url: null,
                        contents_url: null,
                    });
                }
            }

            return changedFiles;
        } catch (error) {
            this.logger.error({
                message: `Failed to get changed files since last commit for PR #${params.prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService',
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
        suggestionCopyPrompt?: boolean;
    }): Promise<AzureRepoPRThread | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                lineComment,
                language,
                suggestionCopyPrompt = true,
            } = params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const translations = getTranslationsForLanguageByCategory(
                language,
                TranslationsCategory.ReviewComment,
            );

            const bodyFormatted = this.formatBodyForAzure(
                lineComment,
                repository,
                translations,
                suggestionCopyPrompt,
            );

            const thread =
                await this.azureReposRequestHelper.createReviewComment({
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

            // Prefer PR commit when a PR number is present; otherwise, use branch (head/base/default)
            let content: { content: string } | null = null;

            const prNumber: number | undefined = (pullRequest as any)?.number;
            if (typeof prNumber === 'number' && !Number.isNaN(prNumber)) {
                try {
                    const commits =
                        await this.azureReposRequestHelper.getCommitsForPullRequest(
                            {
                                orgName,
                                token,
                                projectId,
                                repositoryId: repository.id,
                                prId: prNumber,
                            },
                        );

                    const latestCommit = commits[commits.length - 1];

                    if (latestCommit?.commitId) {
                        content =
                            await this.azureReposRequestHelper.getRepositoryContentFile(
                                {
                                    orgName,
                                    token,
                                    projectId,
                                    repositoryId: repository.id,
                                    commitId: latestCommit.commitId,
                                    filePath: file.filename,
                                },
                            );
                    }
                } catch {
                    // Ignore commit fetch errors and try branch fallback below
                }
            }

            if (!content) {
                let branch: string | undefined =
                    (pullRequest as any)?.head?.ref ||
                    (pullRequest as any)?.base?.ref;
                if (!branch) {
                    try {
                        branch = await this.getDefaultBranch({
                            organizationAndTeamData,
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                        });
                    } catch {}
                }

                if (branch) {
                    // Normalize refs/heads/* to plain branch name for Azure Items API
                    const normalizedBranch = branch.replace(
                        /^refs\/heads\//,
                        '',
                    );

                    try {
                        content =
                            await this.azureReposRequestHelper.getRepositoryContentFile(
                                {
                                    orgName,
                                    token,
                                    projectId,
                                    repositoryId: repository.id,
                                    branch: normalizedBranch,
                                    filePath: file.filename,
                                },
                            );
                    } catch (e: any) {
                        // Fallback: if branch lookup fails (e.g. deleted or PR merged), try latest PR commit again
                        const prNumberFallback: number | undefined = (
                            pullRequest as any
                        )?.number;
                        if (
                            typeof prNumberFallback === 'number' &&
                            !Number.isNaN(prNumberFallback)
                        ) {
                            try {
                                const commitsFallback =
                                    await this.azureReposRequestHelper.getCommitsForPullRequest(
                                        {
                                            orgName,
                                            token,
                                            projectId,
                                            repositoryId: repository.id,
                                            prId: prNumberFallback,
                                        },
                                    );
                                const latestCommitFallback =
                                    commitsFallback?.[
                                        commitsFallback.length - 1
                                    ];
                                if (latestCommitFallback?.commitId) {
                                    content =
                                        await this.azureReposRequestHelper.getRepositoryContentFile(
                                            {
                                                orgName,
                                                token,
                                                projectId,
                                                repositoryId: repository.id,
                                                commitId:
                                                    latestCommitFallback.commitId,
                                                filePath: file.filename,
                                            },
                                        );
                                }
                            } catch {}
                        }
                    }
                }
            }

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

            const enriched = await Promise.all(
                commits.map(async (commit) => {
                    const authorName =
                        commit.author?.email || commit.author?.username || null;

                    let userId: string | null = null;

                    if (authorName) {
                        try {
                            const user = await this.getUserByUsername({
                                organizationAndTeamData,
                                username: authorName,
                            });
                            userId = user?.descriptor ?? user?.originId ?? null;
                        } catch {
                            userId = null;
                        }
                    }

                    let commitParents: string[] = commit.parents || null;

                    if (!commitParents) {
                        try {
                            const commitDetails =
                                await this.azureReposRequestHelper.getCommit({
                                    orgName,
                                    token,
                                    projectId,
                                    repositoryId: repository.id,
                                    commitId: commit.commitId,
                                });
                            commitParents = commitDetails.parents || [];
                        } catch {
                            commitParents = [];
                        }
                    }

                    return {
                        sha: commit.commitId,
                        message: commit.comment,
                        created_at: commit.author?.date,
                        author: {
                            name: commit.author?.name,
                            email: commit.author?.email,
                            date: commit.author?.date,
                            username: authorName,
                            id: userId,
                        },
                        parents:
                            commitParents
                                ?.map((p) => ({
                                    sha: p ?? '',
                                }))
                                ?.filter((p) => p.sha) ?? [],
                    };
                }),
            );

            return enriched.sort(
                (a, b) =>
                    new Date(a.created_at).getTime() -
                    new Date(b.created_at).getTime(),
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error to get commits for pull request for code review',
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
            const { organizationAndTeamData, repository, prNumber, body } =
                params;

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
                throw new Error(
                    `Failed to create issue comment PR#${prNumber}`,
                );
            }

            this.logger.log({
                message: `Created issue comment for PR#${prNumber}`,
                context: this.createIssueComment.name,
                metadata: { params },
            });

            // Modify return object to match expected format
            return {
                ...comment,
                id: comment?.comments?.[0]?.id,
                threadId: comment.id,
            };
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

    async updateIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string; project: { id: string } };
        prNumber: number;
        commentId: number;
        body: string;
        threadId?: number;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                commentId,
                body,
                threadId,
            } = params;
            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            return await this.azureReposRequestHelper.updateCommentOnPullRequest(
                {
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prNumber,
                    threadId,
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
                message: `Failed to update description in pull request #${params.prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService',
                error,
                metadata: { params },
            });
            return null;
        }
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
                        commentType: comment?.commentType,
                        body: comment.content ?? '',
                        createdAt: comment.publishedDate,
                        updatedAt: comment.lastUpdatedDate,
                        isResolved:
                            thread?.status === 'closed' ||
                            thread?.status === 'fixed',
                        author: {
                            id: comment.author?.id,
                            username: comment.author?.displayName,
                            name: comment.author?.displayName,
                        },
                    })),
                )
                .filter((comment) => !hasKodyMarker(comment.body))
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

    async getCloneParams(params: {
        repository: Pick<
            Repository,
            'id' | 'defaultBranch' | 'fullName' | 'name'
        >;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<GitCloneParams> {
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

            return {
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
            };
        } catch (error) {
            this.logger.error({
                message: `Failed to clone repository ${params?.repository?.fullName} from Azure Repos`,
                context: this.getCloneParams.name,
                error: error,
                metadata: { params },
            });
            return null;
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

    async getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null> {
        try {
            const authDetails = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!authDetails?.orgName || !authDetails?.token) {
                return null;
            }

            const { orgName, token } = authDetails;

            const instance = axios.create({
                baseURL: `https://vssps.dev.azure.com/${orgName}`,
                headers: {
                    'Authorization': `Basic ${Buffer.from(`:${decrypt(token)}`).toString('base64')}`,
                    'Content-Type': 'application/json',
                },
            });

            const { data } = await instance.get(
                '/_apis/profile/profiles/me?api-version=7.1-preview',
            );

            const descriptor = await this.resolveCurrentUserDescriptor({
                instance,
                profile: data,
                orgName,
            });

            const normalizedUser = {
                ...data,
                descriptor,
                originId: data?.id,
            };

            if (descriptor) {
                normalizedUser.id = descriptor;
            }

            return normalizedUser || null;
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving current Azure Repos user',
                context: AzureReposService.name,
                serviceName: 'AzureReposService getCurrentUser',
                error: error,
                metadata: params,
            });
            return null;
        }
    }

    private async resolveCurrentUserDescriptor(params: {
        instance: AxiosInstance;
        profile?: any;
        orgName: string;
    }): Promise<string | undefined> {
        const { instance, profile, orgName } = params;

        const descriptorFromProfile =
            profile?.coreAttributes?.SubjectDescriptor?.value ||
            profile?.coreAttributes?.Descriptor?.value ||
            profile?.descriptor;

        if (descriptorFromProfile) {
            return descriptorFromProfile;
        }

        try {
            const { data } = await instance.get(
                '/_apis/connectionData?connectOptions=IncludeServices&api-version=7.1-preview',
            );

            const descriptorFromConnection =
                data?.authenticatedUser?.subjectDescriptor ??
                data?.authenticatedUser?.descriptor;

            if (descriptorFromConnection) {
                return descriptorFromConnection;
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to fetch connectionData while resolving Azure descriptor',
                context: AzureReposService.name,
                serviceName: 'AzureReposService getCurrentUser',
                error,
                metadata: { orgName },
            });
        }

        if (profile?.id) {
            try {
                const { data } = await instance.get(
                    `/_apis/graph/descriptors/${profile.id}?api-version=7.1-preview.1`,
                );
                return data?.value;
            } catch (error) {
                this.logger.warn({
                    message:
                        'Failed to map Azure storage key to descriptor for current user',
                    context: AzureReposService.name,
                    serviceName: 'AzureReposService getCurrentUser',
                    error,
                    metadata: { orgName },
                });
            }
        }

        return undefined;
    }

    async createWebhook(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        try {
            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const repositories: Repositories[] =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories || repositories.length === 0) {
                return null;
            }

            for (const repo of repositories) {
                await this.createNotificationChannel(
                    repo?.project?.id,
                    azureAuthDetail.token,
                    azureAuthDetail.orgName,
                    repo.id,
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

            this.mcpManagerService?.createKodusMCPIntegration(
                params.organizationAndTeamData.organizationId,
            );

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

            const authDetails: AzureReposAuthDetail = {
                orgUrl: orgUrl,
                token: encrypt(token),
                authMode: AuthMode.TOKEN,
                orgName: orgName,
            };

            const checkRepos = await this.checkRepositoryPermissions({
                token: authDetails.token,
                orgUrl: authDetails.orgUrl,
                orgName: authDetails.orgName,
            });

            if (!checkRepos.success) {
                return checkRepos;
            }

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.AZURE_REPOS,
            });

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

    async getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any> {
        const { orgName, token } = await this.getAuthDetails(
            params.organizationAndTeamData,
        );

        const user = await this.azureReposRequestHelper.getUser({
            orgName,
            token,
            identifier: params.username,
        });

        return user ?? null;
    }

    async getUserByEmailOrName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        email?: string;
        userName: string;
    }): Promise<any> {
        const { orgName, token } = await this.getAuthDetails(
            params.organizationAndTeamData,
        );

        const user = await this.azureReposRequestHelper.getUser({
            orgName,
            token,
            identifier: params.userName,
        });

        return user ?? null;
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
                params.type,
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
                queryString += `${
                    queryString ? ' AND ' : ''
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
                    filters: {
                        minTime: filters?.startDate,
                        maxTime: filters?.endDate,
                    },
                });

            return (
                pullRequests?.map((pr) =>
                    this.transformPullRequest(pr, organizationAndTeamData),
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

    /**
     * Retrieves pull requests from Azure DevOps based on the provided parameters.
     * @param params - The parameters for fetching pull requests.
     * @param params.organizationAndTeamData - The organization and team data.
     * @param params.repository - Optional filter for a specific repository name.
     * @param params.filters - Optional filters for dates, state, author, and branch.
     * @returns A promise that resolves to an array of transformed PullRequest objects.
     */
    async getPullRequests(params: {
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
    }): Promise<PullRequest[]> {
        const { organizationAndTeamData, repository, filters = {} } = params;

        try {
            if (!organizationAndTeamData.organizationId) {
                this.logger.warn({
                    message: 'Organization ID is missing in the parameters.',
                    context: AzureReposService.name,
                    metadata: params,
                });
                return [];
            }

            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const { orgName, token } = azureAuthDetail;

            const allRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !azureAuthDetail ||
                !allRepositories ||
                allRepositories.length === 0
            ) {
                this.logger.warn({
                    message: 'No repositories found for the organization.',
                    context: AzureReposService.name,
                    metadata: params,
                });
                return [];
            }

            let reposToProcess = allRepositories;

            if (repository && (repository.name || repository.id)) {
                const foundRepo = allRepositories.find(
                    (r) => r.name === repository.name || r.id === repository.id,
                );

                if (!foundRepo) {
                    this.logger.warn({
                        message: `Repository ${repository.name} (id: ${repository.id}) not found in the list of repositories.`,
                        context: AzureReposService.name,
                        metadata: params,
                    });
                    return [];
                }

                reposToProcess = [foundRepo];
            }

            const promises = reposToProcess.map((r) =>
                this.getPullRequestsByRepo({
                    orgName,
                    token,
                    projectId: r.project.id,
                    repositoryId: r.id,
                    filters,
                }),
            );

            const results = await Promise.all(promises);
            const rawPullRequests = results.flat();

            return rawPullRequests.map((rawPr) =>
                this.transformPullRequest(rawPr, organizationAndTeamData),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull requests from Azure DevOps',
                context: AzureReposService.name,
                error,
                metadata: params,
            });
            return [];
        }
    }

    /**
     * Retrieves pull requests from a specific Azure DevOps repository.
     * @param params - The parameters for fetching, including the API instance, repo info, and filters.
     * @returns A promise that resolves to an array of raw pull request data.
     */
    private async getPullRequestsByRepo(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filters: {
            state?: PullRequestState;
            author?: string;
            branch?: string;
            startDate?: Date;
            endDate?: Date;
        };
    }): Promise<AzureRepoPullRequest[]> {
        const {
            orgName,
            token,
            projectId,
            repositoryId,
            filters = {},
        } = params;
        const { author, branch, state, startDate, endDate } = filters;

        return await this.azureReposRequestHelper.getPullRequestsByRepo({
            orgName,
            token,
            projectId,
            repositoryId,
            filters: {
                author,
                branch,
                status: state
                    ? this._prStateMapReversed.get(state)
                    : this._prStateMapReversed.get(PullRequestState.ALL),
                maxTime: endDate ? endDate.toISOString() : undefined,
                minTime: startDate ? startDate.toISOString() : undefined,
            },
        });
    }

    async getPullRequestsWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: {
            period?: { startDate?: string; endDate?: string };
            prStatus?: string;
            repositoryId?: string;
            limit?: number;
            skipFiles?: boolean;
        };
    }): Promise<PullRequestWithFiles[] | null> {
        try {
            const { organizationAndTeamData } = params;
            const filters = params.filters ?? {};

            const { prStatus } = filters;
            const perRepoLimit = Math.min(Math.max(filters?.limit || 5, 1), 10);
            const repoFilter = filters?.repositoryId
                ? new Set([String(filters.repositoryId)])
                : null;
            const useFastPath = Boolean(
                filters?.repositoryId || filters?.limit,
            );

            const stateMap = {
                open: AzurePRStatus.ACTIVE,
                closed: AzurePRStatus.ABANDONED,
                merged: AzurePRStatus.COMPLETED,
            };

            // Normalize the input to lowercase and look it up in the stateMap
            const normalizedStatus = prStatus
                ? stateMap[prStatus.toLowerCase()] || AzurePRStatus.ACTIVE
                : AzurePRStatus.ACTIVE;

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
                    if (
                        repoFilter &&
                        !repoFilter.has(String(repo.id)) &&
                        !repoFilter.has(String(repo.name))
                    ) {
                        return { repo, prs: [] };
                    }

                    const prs =
                        await this.azureReposRequestHelper.getPullRequestsByRepo(
                            {
                                orgName,
                                token,
                                projectId: repo.project.id,
                                repositoryId: repo.id,
                                filters: {
                                    minTime: startDate,
                                    maxTime: endDate,
                                    status: normalizedStatus,
                                },
                            },
                        );
                    let filteredPrs = prs;

                    if (useFastPath) {
                        filteredPrs = prs
                            .sort(
                                (a, b) =>
                                    new Date(b.creationDate).getTime() -
                                    new Date(a.creationDate).getTime(),
                            )
                            .slice(0, perRepoLimit);
                    }

                    return { repo, prs: filteredPrs };
                }),
            );

            let pullRequestsWithFiles: PullRequestWithFiles[] = [];

            await Promise.all(
                reposWithPRs.map(async ({ repo, prs }) => {
                    const prsWithDiffs = await Promise.all(
                        prs.map(async (pr) => {
                            if (useFastPath && filters?.skipFiles) {
                                const prWithFileChanges: PullRequestWithFiles =
                                    {
                                        id: pr.pullRequestId,
                                        pull_number: pr.pullRequestId,
                                        state: pr.status,
                                        title: pr.title,
                                        repository: {
                                            id: repo.id,
                                            name: repo.name,
                                        },
                                        repositoryData: repo as any,
                                        pullRequestFiles: [],
                                    };

                                return prWithFileChanges;
                            }

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

                            const prWithFileChanges: PullRequestWithFiles = {
                                id: pr.pullRequestId,
                                pull_number: pr.pullRequestId,
                                state: pr.status,
                                title: pr.title,
                                repository: { id: repo.id, name: repo.name },
                                repositoryData: repo as any,
                                pullRequestFiles: diffs as any,
                            };

                            return prWithFileChanges;
                        }),
                    );

                    pullRequestsWithFiles.push(...prsWithDiffs);
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

    async countReactions(params: {
        comments: any[];
        pr: any;
    }): Promise<any[] | null> {
        try {
            const { comments, pr } = params;

            const thumbsUpText = '👍';
            const thumbsDownText = '👎';

            const commentsWithNumberOfReactions = comments
                .filter(
                    (comment: any) =>
                        comment.replies && comment.replies.length > 0,
                )
                .map((comment: any) => {
                    comment.totalReactions = 0;
                    comment.thumbsUp = 0;
                    comment.thumbsDown = 0;

                    const userReactions = new Map();

                    comment.replies.forEach((reply) => {
                        const userId = reply?.author?.id;
                        const replyBody = reply?.body;

                        // Check if values were found
                        if (!userId || typeof replyBody !== 'string') {
                            return; // Skip this reply if data is missing
                        }

                        // Initialize user reaction if not already present
                        if (!userReactions.has(userId)) {
                            userReactions.set(userId, {
                                thumbsUp: false,
                                thumbsDown: false,
                            });
                        }

                        const userReaction = userReactions.get(userId);

                        // Check for thumbs up reaction
                        if (
                            replyBody.includes(thumbsUpText) &&
                            !userReaction.thumbsUp
                        ) {
                            comment.thumbsUp++;
                            userReaction.thumbsUp = true;
                        }

                        // Check for thumbs down reaction
                        if (
                            replyBody.includes(thumbsDownText) &&
                            !userReaction.thumbsDown
                        ) {
                            comment.thumbsDown++;
                            userReaction.thumbsDown = true;
                        }
                    });

                    comment.totalReactions =
                        comment.thumbsUp + comment.thumbsDown;

                    return comment;
                });

            const reactionsInComments: ReactionsInComments[] =
                commentsWithNumberOfReactions
                    .filter((comment) => comment.totalReactions > 0)
                    .map((comment: any) => ({
                        reactions: {
                            thumbsUp: comment.thumbsUp,
                            thumbsDown: comment.thumbsDown,
                        },
                        comment: {
                            id: comment.threadId,
                            body: comment.body,
                            pull_request_review_id: pr.pull_number,
                        },
                        pullRequest: {
                            id: pr.id,
                            number: pr.pull_number,
                            repository: {
                                id: pr.repository.id,
                                fullName: pr.repository.name,
                            },
                        },
                    }));

            return reactionsInComments;
        } catch (error) {
            this.logger.error({
                message: `Error when trying to count reactions in PR${params.pr.pull_number}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService countReactions',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async getRepositories(params: {
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
            };
        };
    }): Promise<Repositories[]> {
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

            const repositories: Repositories[] = projectsWithRepos.flatMap(
                ({ project, repositories }) =>
                    repositories.map((repo) =>
                        this.transformRepo(repo, project, integrationConfig),
                    ),
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
            lastActivityAt: repo?.lastUpdateTime ?? project?.lastUpdateTime,
        };
    }

    async getCommits(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: Partial<Repository>;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            author?: string;
            branch?: string;
        };
    }): Promise<Commit[]> {
        const { organizationAndTeamData, repository, filters = {} } = params;

        try {
            const azureAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const { orgName, token } = azureAuthDetail;

            const configuredRepositories: Repositories[] =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (
                !azureAuthDetail ||
                !configuredRepositories ||
                configuredRepositories.length === 0
            ) {
                this.logger.warn({
                    message:
                        'Azure Repos auth details or repositories not found.',
                    context: AzureReposService.name,
                    metadata: params,
                });

                return [];
            }

            let reposToProcess: Repositories[] = configuredRepositories;

            // If a specific repository is requested, filter the list.
            if (repository && repository.name) {
                const foundRepo = configuredRepositories.find(
                    (r) => r.name === repository.name,
                );

                if (!foundRepo) {
                    this.logger.warn({
                        message: `Repository ${repository.name} not found in the list of configured repositories.`,
                        context: AzureReposService.name,
                        metadata: params,
                    });
                    return [];
                }

                reposToProcess = [foundRepo];
            }

            const promises = reposToProcess.map((repo) =>
                this.getCommitsByRepo({
                    orgName,
                    token,
                    projectId: repo.project.id,
                    repositoryId: repo.id,
                    filters,
                }),
            );

            const results = await Promise.all(promises);
            const rawCommits = results.flat();

            return rawCommits.map((rawCommit) =>
                this.transformCommit(rawCommit),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error fetching commits from Azure Repos',
                context: AzureReposService.name,
                error: error,
                metadata: params,
            });
            return [];
        }
    }

    /**
     * Fetches commits for a single Azure repository, applying server-side filters.
     * @param params Parameters including auth, repo identifiers, and filters.
     * @returns A promise that resolves to an array of raw commit data.
     */
    private async getCommitsByRepo(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filters: {
            startDate?: Date;
            endDate?: Date;
            author?: string;
            branch?: string;
        };
    }): Promise<AzureRepoCommit[]> {
        const {
            orgName,
            token,
            projectId,
            repositoryId,
            filters = {},
        } = params;
        const { startDate, endDate, author, branch } = filters;

        return this.azureReposRequestHelper.getCommits({
            orgName,
            token,
            projectId,
            repositoryId,
            filters: {
                author,
                branch,
                fromDate: startDate?.toISOString(),
                toDate: endDate?.toISOString(),
            },
        });
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
            const pr = await this.azureReposRequestHelper.getPullRequestDetails(
                {
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                },
            );

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
            const iterations = await this.azureReposRequestHelper.getIterations(
                {
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                },
            );

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
            const changesResponse =
                await this.azureReposRequestHelper.getChanges({
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
                metadata: {
                    prNumber,
                    iterationId,
                    changeEntriesLength: changeEntries.length,
                },
            });

            // 4. Process each change entry to generate the diff using our specific base and target commits
            const fileDiffPromises = changeEntries
                .filter((change) => change.item?.path || change?.originalPath) // Ensure item and path exist
                .map((change) => {
                    const filePath = change.item?.path || change?.originalPath;
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
                metadata: {
                    prNumber,
                    successfulFilesLength: successfulFiles.length,
                },
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
            if (status !== 'removed') {
                // Compare with 'removed'
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
            } else if (status === 'removed') {
                // Compare with 'removed'
                // Handle deleted files explicitly if needed (e.g., create a dummy patch or specific log)
                patch = `--- a/${filePath}\n+++ /dev/null\n File deleted`; // Example dummy patch
                deletions = 0; // Or calculate based on original file lines if fetched
            } else if (status === 'added') {
                // Compare with string literal
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
                this.findOneByOrganizationAndTeamDataAndConfigKey(
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
                    status: true,
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
        const EVENT_CONFIGS: EventConfig[] = [
            { type: 'git.pullrequest.created', resourceVersion: '1.0' },
            { type: 'git.pullrequest.updated', resourceVersion: '1.0' },
            {
                type: 'ms.vss-code.git-pullrequest-comment-event',
                resourceVersion: '2.0',
            },
        ];

        const webhookUrl =
            process.env.GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK!;
        const encryptedToken = generateWebhookToken();

        const tasks = EVENT_CONFIGS.map(({ type, resourceVersion }) =>
            this.createOrReplaceHook({
                orgName: organizationName,
                token: userToken,
                projectId,
                repoId,
                eventType: type,
                resourceVersion,
                webhookUrl,
                encryptedToken,
            }).catch((error) => {
                this.logger.error({
                    message: `Erro no hook ${type}: ${error.message ?? error}`,
                    context: this.createNotificationChannel.name,
                    error,
                    metadata: {
                        eventType: type,
                        organizationName,
                        projectId,
                        repoId,
                    },
                });
            }),
        );

        // Aguardar todas, mas já lidamos com erros acima
        await Promise.all(tasks);
    }

    private async createOrReplaceHook(opts: {
        orgName: string;
        token: string;
        projectId: string;
        repoId: string;
        eventType: string;
        resourceVersion: string;
        webhookUrl: string;
        encryptedToken: string;
    }): Promise<void> {
        const {
            orgName,
            token,
            projectId,
            repoId,
            eventType,
            resourceVersion,
            webhookUrl,
            encryptedToken,
        } = opts;

        try {
            const payload = {
                publisherId: 'tfs',
                eventType,
                resourceVersion,
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: { projectId, repository: repoId },
                consumerInputs: {
                    url: `${webhookUrl}?token=${encodeURIComponent(encryptedToken)}`,
                    resourceDetailsToSend: 'all',
                    messagesToSend: 'all',
                    detailedMessagesToSend: 'all',
                },
            };

            // Lista assinaturas existentes
            const subs =
                await this.azureReposRequestHelper.listSubscriptionsByProject({
                    orgName,
                    token,
                    projectId,
                });

            const existing = subs.find(
                (s) =>
                    s.eventType === eventType &&
                    s.publisherInputs?.repository === repoId &&
                    s.consumerInputs?.url?.includes(webhookUrl),
            );

            if (existing) {
                await this.azureReposRequestHelper.deleteWebhookById({
                    orgName,
                    token,
                    subscriptionId: existing.id,
                });
                this.logger.log({
                    message: `Webhook removed for ${eventType} (id=${existing.id})`,
                    context: this.createOrReplaceHook.name,
                    metadata: { eventType, subscriptionId: existing.id },
                });
            }

            // Cria nova assinatura
            const created =
                await this.azureReposRequestHelper.createSubscriptionForProject(
                    {
                        orgName,
                        token,
                        projectId,
                        subscriptionPayload: payload,
                    },
                );
            this.logger.log({
                message: `Webhook create for ${eventType} (id=${created.id})`,
                context: this.createOrReplaceHook.name,
                metadata: { eventType, subscriptionId: created.id },
            });
        } catch (error) {
            this.logger.error({
                message: `Error creating/replacing hook for ${eventType}: ${error.message ?? error}`,
                context: this.createOrReplaceHook.name,
                error,
                metadata: { eventType, orgName, projectId, repoId },
            });
        }
    }

    private formatCodeBlock(language: string, code: string) {
        return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    private formatSub(text: string) {
        return `<sub>${text}</sub>\n\n`;
    }

    private formatPromptForLLM(lineComment: any) {
        let copyPrompt = '';
        if (lineComment?.suggestion?.llmPrompt) {
            if (lineComment.path) {
                copyPrompt += `File ${lineComment.path}:\n\n`;
            }

            if (lineComment.start_line && lineComment.line) {
                copyPrompt += `Line ${lineComment.start_line} to ${lineComment.line}:\n\n`;
            } else if (lineComment.line) {
                copyPrompt += `Line ${lineComment.line}:\n\n`;
            }

            copyPrompt += lineComment?.suggestion?.llmPrompt;

            if (lineComment?.body?.improvedCode) {
                copyPrompt +=
                    '\n\nSuggested Code:\n\n' + lineComment?.body?.improvedCode;
            }

            copyPrompt = `\n\n<details>

<summary>Prompt for LLM</summary>

\`\`\`

${copyPrompt}

\`\`\`

</details>\n\n`;
        }

        return copyPrompt;
    }

    private formatBodyForAzure(
        lineComment: any,
        repository: any,
        translations: any,
        suggestionCopyPrompt?: boolean,
    ) {
        const severityShield = lineComment?.suggestion
            ? getSeverityLevelShield(lineComment.suggestion.severity)
            : '';
        const codeBlock = lineComment?.body?.improvedCode
            ? this.formatCodeBlock(
                  repository?.language?.toLowerCase(),
                  lineComment?.body?.improvedCode,
              )
            : '';
        const suggestionContent = lineComment?.body?.suggestionContent || '';
        const actionStatement = lineComment?.body?.actionStatement
            ? `${lineComment.body.actionStatement}\n\n`
            : '';

        const badges =
            [
                getCodeReviewBadge(),
                lineComment?.suggestion
                    ? getLabelShield(lineComment.suggestion.label)
                    : '',
                severityShield,
            ].join(' ') + '\n\n';

        const thumbsUpBlock = `\`\`\`\n👍\n\`\`\`\n`;
        const thumbsDownBlock = `\`\`\`\n👎\n\`\`\`\n`;

        const copyPrompt = suggestionCopyPrompt
            ? this.formatPromptForLLM(lineComment)
            : '';

        return [
            badges,
            suggestionContent,
            actionStatement,
            codeBlock,
            copyPrompt,
            this.formatSub(translations.talkToKody),
            this.formatSub(translations.feedback) +
                '<!-- kody-codereview -->&#8203;\n&#8203;',
            thumbsUpBlock,
            thumbsDownBlock,
        ]
            .join('\n')
            .trim();
    }

    private filterIterationsAfterCommit(params: {
        iterations: any[];
        commits: { commitId: string }[];
        lastReviewedCommitId: string;
    }): any[] {
        const { iterations, commits, lastReviewedCommitId } = params;

        const reviewedIndex = commits.findIndex(
            (commit) => commit.commitId === lastReviewedCommitId,
        );

        if (reviewedIndex === -1) {
            throw new Error(
                `Commit ${lastReviewedCommitId} not found in PR commit history`,
            );
        }

        return iterations.filter((iteration) => {
            const commitId = iteration.sourceRefCommit?.commitId;
            if (!commitId) return false;

            const iterationIndex = commits.findIndex(
                (commit) => commit.commitId === commitId,
            );
            return iterationIndex > reviewedIndex;
        });
    }

    private getListOfCriticalIssues(criticalComments: CommentResult[]): string {
        const criticalIssuesSummaryArray =
            this.getCriticalIssuesSummaryArray(criticalComments);

        const listOfCriticalIssues = criticalIssuesSummaryArray
            .map((criticalIssue) => {
                const summary = criticalIssue.oneSentenceSummary;
                const formattedItem = `- ${summary}`;

                return formattedItem.trim();
            })
            .join('\n');

        return listOfCriticalIssues;
    }

    private getCriticalIssuesSummaryArray(
        criticalComments: CommentResult[],
    ): OneSentenceSummaryItem[] {
        const criticalIssuesSummaryArray: OneSentenceSummaryItem[] =
            criticalComments.map((comment) => {
                return {
                    id: comment.codeReviewFeedbackData.commentId,
                    oneSentenceSummary:
                        comment.comment.suggestion.oneSentenceSummary ?? '',
                };
            });

        return criticalIssuesSummaryArray;
    }

    async isWebhookActive(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<boolean> {
        const { organizationAndTeamData, repositoryId } = params;

        try {
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetails) {
                return false;
            }

            const repository = await this.getRepoById(
                organizationAndTeamData,
                repositoryId,
            );

            if (!repository) {
                return false;
            }

            const resolvedProjectId = repository.project?.id;

            if (!resolvedProjectId) {
                return false;
            }

            const webhookUrl =
                this.configService.get<string>(
                    'GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK',
                ) ?? process.env.GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK;

            if (!webhookUrl) {
                return false;
            }

            const subscriptions =
                await this.azureReposRequestHelper.listSubscriptionsByProject({
                    orgName: authDetails.orgName,
                    token: authDetails.token,
                    projectId: resolvedProjectId,
                });

            return subscriptions.some(
                (subscription) =>
                    subscription.publisherInputs?.repository === repositoryId &&
                    subscription.consumerInputs?.url?.includes(webhookUrl),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error verifying Azure Repos webhook status',
                context: AzureReposService.name,
                serviceName: 'AzureReposService isWebhookActive',
                error: error,
                metadata: {
                    organizationAndTeamData,
                    repositoryId,
                },
            });

            return false;
        }
    }

    async deleteWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        const authDetails = await this.getAuthDetails(
            params.organizationAndTeamData,
        );

        // Se for conexão via PAT, remove os webhooks
        if (authDetails.authMode === AuthMode.TOKEN) {
            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (repositories) {
                for (const repo of repositories) {
                    try {
                        const projectId = await this.getProjectIdFromRepository(
                            params.organizationAndTeamData,
                            repo.id,
                        );

                        if (!projectId) {
                            continue;
                        }

                        const subs =
                            await this.azureReposRequestHelper.listSubscriptionsByProject(
                                {
                                    orgName: authDetails.orgName,
                                    token: authDetails.token,
                                    projectId,
                                },
                            );

                        const webhookUrl = this.configService.get<string>(
                            'GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK'!,
                        );
                        const allMatching = subs.filter(
                            (s) =>
                                s.publisherInputs?.repository === repo.id &&
                                s.consumerInputs?.url?.includes(webhookUrl),
                        );

                        for (const existing of allMatching) {
                            await this.azureReposRequestHelper.deleteWebhookById(
                                {
                                    orgName: authDetails.orgName,
                                    token: authDetails.token,
                                    subscriptionId: existing.id,
                                },
                            );

                            this.logger.log({
                                message: `Webhook removed for repository ${repo.name} (id=${existing.id})`,
                                context: this.deleteWebhook.name,
                                metadata: {
                                    organizationAndTeamData:
                                        params.organizationAndTeamData,
                                    repository: repo.name,
                                    subscriptionId: existing.id,
                                },
                            });
                        }
                    } catch (error) {
                        this.logger.error({
                            message: `Error deleting webhook for repository ${repo.name}`,
                            context: this.deleteWebhook.name,
                            error: error,
                            metadata: {
                                organizationAndTeamData:
                                    params.organizationAndTeamData,
                                repository: repo.name,
                            },
                        });
                    }
                }
            }
        }
    }

    formatReviewCommentBody(params: {
        suggestion: any;
        repository: { name: string; language: string };
        includeHeader?: boolean;
        includeFooter?: boolean;
        language?: string;
        organizationAndTeamData: OrganizationAndTeamData;
        suggestionCopyPrompt?: boolean;
    }): Promise<string> {
        const {
            suggestion,
            repository,
            includeHeader = true,
            includeFooter = true,
            language,
            suggestionCopyPrompt = true,
        } = params;

        let commentBody = '';

        // HEADER - Badges
        if (includeHeader) {
            const severityShield = suggestion?.severity
                ? getSeverityLevelShield(suggestion.severity)
                : '';

            const badges = [
                getCodeReviewBadge(),
                suggestion?.label ? getLabelShield(suggestion.label) : '',
                severityShield,
            ]
                .filter(Boolean)
                .join(' ');

            commentBody += `${badges}\n\n`;
        }

        // BODY - Conteúdo principal
        if (suggestion?.suggestionContent) {
            commentBody += `${suggestion.suggestionContent}\n\n`;
        }

        if (suggestion?.clusteringInformation?.actionStatement) {
            commentBody += `${suggestion.clusteringInformation.actionStatement}\n\n`;
        }

        if (suggestion?.improvedCode) {
            const lang = repository?.language?.toLowerCase() || 'javascript';
            commentBody += `\`\`\`${lang}\n${suggestion.improvedCode}\n\`\`\`\n\n`;
        }

        if (suggestionCopyPrompt) {
            commentBody += this.formatPromptForLLM(suggestion);
        }

        // FOOTER - Interação/Feedback
        if (includeFooter) {
            const translations = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.ReviewComment,
            );

            commentBody += this.formatSub(translations.talkToKody) + '\n';
            commentBody += this.formatSub(translations.feedback) + '\n\n';

            const thumbsUpBlock = `\`\`\`\n👍\n\`\`\`\n`;
            const thumbsDownBlock = `\`\`\`\n👎\n\`\`\`\n`;
            commentBody += thumbsUpBlock + thumbsDownBlock;
        }

        return Promise.resolve(commentBody.trim());
    }

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
    }): Promise<any | null> {
        throw new Error('Method not implemented.');
    }

    async getPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequest | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

        try {
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!projectId) {
                throw new Error(
                    `Project ID not found for repository ${repository.name}`,
                );
            }

            const pullRequest =
                await this.azureReposRequestHelper.getPullRequestDetails({
                    orgName: authDetails.orgName,
                    token: authDetails.token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                });

            if (!pullRequest) {
                this.logger.warn({
                    message: `Pull request #${prNumber} not found in repository ${repository.name}`,
                    context: this.getPullRequest.name,
                    metadata: {
                        organizationAndTeamData,
                        repository: repository.name,
                        prNumber,
                    },
                });
                return null;
            }

            const pr = this.transformPullRequest(
                pullRequest,
                organizationAndTeamData,
            );

            return pr;
        } catch (error) {
            this.logger.error({
                message: `Error getting pull request details for #${prNumber} in repository ${repository.name}`,
                context: this.getPullRequest.name,
                error: error,
                metadata: {
                    organizationAndTeamData,
                    repository: repository.name,
                    prNumber,
                },
            });
            return null; // Return null to indicate failure
        }
    }

    async getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<any[]> {
        try {
            const { organizationAndTeamData, repositoryId } = params;

            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) {
                this.logger.error({
                    message: 'Azure Repos auth details not found',
                    context: this.getRepositoryTree.name,
                    metadata: { organizationAndTeamData, repositoryId },
                });
                return [];
            }

            const { orgName, token } = authDetails;
            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repositoryId,
            );

            if (!projectId) {
                this.logger.error({
                    message:
                        'Project ID not found for Azure Repos repository tree',
                    context: this.getRepositoryTree.name,
                    metadata: { organizationAndTeamData, repositoryId },
                });
                return [];
            }

            const tree = await this.azureReposRequestHelper.getRepositoryTree({
                orgName,
                token,
                projectId,
                repositoryId,
                recursive: true,
            });

            if (!tree || !Array.isArray(tree)) {
                this.logger.warn({
                    message: 'No repository tree found or invalid response',
                    context: this.getRepositoryTree.name,
                    metadata: { organizationAndTeamData, repositoryId },
                });
                return [];
            }

            const normalizedTree = tree.map((item) => ({
                path: item.path?.startsWith('/')
                    ? item.path.substring(1)
                    : item.path, // Remove '/' inicial se existir
                type: item.gitObjectType === 'tree' ? 'directory' : 'file',
                sha: item.objectId,
                size: undefined,
                url: item.url,
            }));

            this.logger.debug({
                message: `Azure Repos tree normalized: ${normalizedTree.length} items`,
                context: this.getRepositoryTree.name,
                metadata: {
                    organizationAndTeamData,
                    repositoryId,
                    totalItems: normalizedTree.length,
                },
            });

            return normalizedTree;
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree from Azure Repos',
                context: this.getRepositoryTree.name,
                error: error,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId: params.repositoryId,
                },
            });
            return [];
        }
    }

    async getRepositoryTreeByDirectory(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        directoryPath?: string;
    }): Promise<TreeItem[]> {
        try {
            const { organizationAndTeamData, repositoryId, directoryPath } =
                params;

            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetails) {
                this.logger.error({
                    message: 'Azure Repos auth details not found',
                    context: this.getRepositoryTreeByDirectory.name,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId,
                        directoryPath,
                    },
                });
                return [];
            }

            const { orgName, token } = authDetails;
            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repositoryId,
            );

            if (!projectId) {
                this.logger.error({
                    message:
                        'Project ID not found for Azure Repos repository tree',
                    context: this.getRepositoryTreeByDirectory.name,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId,
                        directoryPath,
                    },
                });
                return [];
            }

            // Buscar apenas um nível do diretório especificado
            const items =
                await this.azureReposRequestHelper.getRepositoryTreeByDirectory(
                    {
                        orgName,
                        token,
                        projectId,
                        repositoryId,
                        scopePath: directoryPath
                            ? `/${directoryPath}`
                            : undefined,
                        recursionLevel: 'OneLevel',
                    },
                );

            if (!items || !Array.isArray(items)) {
                this.logger.warn({
                    message: 'No items found or invalid response',
                    context: this.getRepositoryTreeByDirectory.name,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId,
                        directoryPath,
                    },
                });
                return [];
            }

            // Normalizar o scopePath para comparação (remover '/' inicial)
            const normalizedScopePath = directoryPath?.startsWith('/')
                ? directoryPath.substring(1)
                : directoryPath;

            // Filtrar apenas diretórios e EXCLUIR o próprio diretório pai
            const directories = items
                .filter((item) => {
                    // Remover '/' inicial do path para comparação
                    const itemPath = item.path?.startsWith('/')
                        ? item.path.substring(1)
                        : item.path;

                    // Excluir o próprio diretório pai (evitar loop)
                    const isSelfDirectory =
                        normalizedScopePath && itemPath === normalizedScopePath;

                    // Incluir apenas se for pasta E não for o próprio diretório
                    return (
                        item.gitObjectType === 'tree' &&
                        item.isFolder &&
                        !isSelfDirectory
                    );
                })
                .map((item) => {
                    // Remover '/' inicial do path
                    const normalizedPath = item.path?.startsWith('/')
                        ? item.path.substring(1)
                        : item.path;

                    return {
                        path: normalizedPath,
                        type: 'directory' as const,
                        sha: item.objectId,
                        size: undefined,
                        url: item.url,
                        hasChildren: true,
                    };
                });

            this.logger.debug({
                message: `Azure Repos tree by directory: ${directories.length} directories`,
                context: this.getRepositoryTreeByDirectory.name,
                metadata: {
                    organizationAndTeamData,
                    repositoryId,
                    directoryPath: directoryPath || 'root',
                    totalDirectories: directories.length,
                },
            });

            return directories;
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting repository tree by directory from Azure Repos',
                context: this.getRepositoryTreeByDirectory.name,
                error: error,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId: params.repositoryId,
                    directoryPath: params.directoryPath,
                },
            });
            return [];
        }
    }

    async getRepositoryAllFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        filters?: {
            branch?: string;
            filePatterns?: string[];
            excludePatterns?: string[];
            maxFiles?: number;
        };
    }): Promise<RepositoryFile[]> {
        try {
            const {
                organizationAndTeamData,
                repository,
                filters = {},
            } = params;

            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetails) {
                this.logger.warn({
                    message: `No auth details found for organization ${organizationAndTeamData.organizationId}`,
                    context: this.getRepositoryAllFiles.name,
                    metadata: params,
                });

                return [];
            }

            const { orgName, token } = authDetails;

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!projectId) {
                this.logger.warn({
                    message: `Project ID not found for repository ${repository.name}`,
                    context: this.getRepositoryAllFiles.name,
                    metadata: params,
                });

                return [];
            }

            const {
                filePatterns,
                excludePatterns,
                maxFiles = 1000,
            } = filters ?? {};

            let branch = filters?.branch;

            if (!branch || branch.length === 0) {
                branch = await this.getDefaultBranch({
                    organizationAndTeamData,
                    repository,
                });

                if (!branch) {
                    this.logger.warn({
                        message: `Default branch not found for repository ${repository.name}`,
                        context: this.getRepositoryAllFiles.name,
                        metadata: params,
                    });

                    return [];
                }
            }

            const fileItems =
                await this.azureReposRequestHelper.listRepositoryFiles({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    filters: {
                        branch,
                    },
                });

            if (!fileItems || fileItems.length === 0) {
                this.logger.warn({
                    message: `No files found in repository ${repository.name}`,
                    context: this.getRepositoryAllFiles.name,
                    metadata: params,
                });

                return [];
            }

            let files = fileItems
                .filter((fileItem) => !fileItem.isFolder)
                .map((fileItem) => this.transformRepositoryFile(fileItem));

            const filteredFiles: RepositoryFile[] = [];
            for (const file of files) {
                if (maxFiles > 0 && filteredFiles.length >= maxFiles) {
                    break;
                }

                if (
                    filePatterns &&
                    filePatterns.length > 0 &&
                    !isFileMatchingGlobCaseInsensitive(file.path, filePatterns)
                ) {
                    continue;
                }

                if (
                    excludePatterns &&
                    excludePatterns.length > 0 &&
                    isFileMatchingGlob(file.path, excludePatterns)
                ) {
                    continue;
                }

                filteredFiles.push(file);
            }

            this.logger.log({
                message: `Retrieved ${filteredFiles.length} files from repository ${repository.name} after filtering`,
                context: this.getRepositoryAllFiles.name,
                metadata: {
                    organizationAndTeamData,
                    repository: repository.name,
                    filters,
                },
            });

            return filteredFiles;
        } catch (error) {
            this.logger.error({
                message: `Error getting all files for repository ${params.repository.name}`,
                context: this.getRepositoryAllFiles.name,
                error: error,
                metadata: { params },
            });

            return [];
        }
    }

    async updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        parentId: string;
        commentId: string;
        body: string;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any | null> {
        const {
            organizationAndTeamData,
            parentId,
            commentId,
            body,
            repository,
            prNumber,
        } = params;

        try {
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) {
                this.logger.error({
                    message: 'Azure Repos auth details not found',
                    context: this.updateResponseToComment.name,
                    metadata: { organizationAndTeamData, repository },
                });
                return null;
            }

            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!projectId) {
                this.logger.error({
                    message: `Project ID not found for repository ${repository.name}`,
                    context: this.updateResponseToComment.name,
                    metadata: { organizationAndTeamData, repository },
                });
                return null;
            }

            const response =
                await this.azureReposRequestHelper.updateThreadComment({
                    orgName: authDetails.orgName,
                    token: authDetails.token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                    threadId: Number(parentId),
                    commentId: Number(commentId),
                    body,
                });

            return response;
        } catch (error) {
            this.logger.error({
                message: `Error updating response to comment ${commentId} in PR #${prNumber} for repository ${repository.name}`,
                context: this.updateResponseToComment.name,
                error: error,
                metadata: {
                    organizationAndTeamData,
                    repository: repository.name,
                    prNumber,
                    commentId,
                    parentId,
                },
            });
            return null;
        }
    }

    async isDraftPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<boolean> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const pr = await this.getPullRequest({
                organizationAndTeamData,
                repository,
                prNumber,
            });

            return pr?.isDraft ?? false;
        } catch (error) {
            this.logger.error({
                message: `Error checking if PR #${params.prNumber} is draft in repository ${params.repository.name}`,
                context: this.isDraftPullRequest.name,
                error: error,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository.name,
                    prNumber: params.prNumber,
                },
            });
            return false;
        }
    }

    //#region Transformers

    /**
     * Transforms a raw commit from the Azure DevOps API into the standard Commit interface.
     * @param rawCommit The raw commit data from Azure Repos.
     * @returns A Commit object.
     */
    private transformCommit(rawCommit: AzureRepoCommit): Commit {
        return {
            sha: rawCommit.commitId ?? '',
            commit: {
                author: {
                    id: rawCommit.author?.id ?? '',
                    name: rawCommit.author?.name ?? '',
                    email: rawCommit.author?.email ?? '',
                    date: rawCommit.author?.date?.toString() ?? '',
                },
                message: rawCommit.comment ?? '',
            },
            parents:
                rawCommit.parents
                    ?.map((parentSha) => ({ sha: parentSha }))
                    .filter((parent) => parent.sha) ?? [],
        };
    }

    private readonly _prStateMap = new Map<AzurePRStatus, PullRequestState>([
        [AzurePRStatus.ACTIVE, PullRequestState.OPENED],
        [AzurePRStatus.COMPLETED, PullRequestState.MERGED],
        [AzurePRStatus.ABANDONED, PullRequestState.CLOSED],
        [AzurePRStatus.NOT_SET, PullRequestState.ALL],
        [AzurePRStatus.ALL, PullRequestState.ALL],
    ]);

    private readonly _prStateMapReversed = new Map<
        PullRequestState,
        AzurePRStatus
    >([
        [PullRequestState.OPENED, AzurePRStatus.ACTIVE],
        [PullRequestState.MERGED, AzurePRStatus.COMPLETED],
        [PullRequestState.CLOSED, AzurePRStatus.ABANDONED],
        [PullRequestState.ALL, AzurePRStatus.ALL],
    ]);

    private readonly _prClosedStates: Array<AzurePRStatus> = [
        AzurePRStatus.COMPLETED,
        AzurePRStatus.ABANDONED,
    ];

    /**
     * Transforms a raw pull request from Azure DevOps into the standard PullRequest interface.
     * @param pr The raw pull request data from Azure Repos.
     * @param organizationId The ID of the organization.
     * @returns A PullRequest object.
     */
    private transformPullRequest(
        pr: AzureRepoPullRequest,
        organizationAndTeamData: OrganizationAndTeamData,
    ): PullRequest {
        return {
            id: pr.pullRequestId?.toString() ?? '',
            number: pr?.pullRequestId ?? -1,
            pull_number: pr?.pullRequestId ?? -1, // TODO: remove, legacy, use number
            repository: pr?.repository?.name ?? '', // TODO: remove, legacy, use repositoryData
            repositoryId: pr?.repository?.id ?? '', // TODO: remove, legacy, use repositoryData
            repositoryData: {
                id: pr?.repository?.id ?? '',
                name: pr?.repository?.name ?? '',
            },
            message: pr?.description ?? '',
            state: this._prStateMap.get(pr?.status) ?? PullRequestState.ALL,
            prURL: pr?.url ?? '',
            organizationId: organizationAndTeamData?.organizationId ?? '',
            body: pr?.description ?? '',
            title: pr?.title ?? '',
            created_at: pr?.creationDate ?? '',
            closed_at: pr?.closedDate ?? '',
            updated_at: this._prClosedStates.includes(pr?.status)
                ? (pr?.closedDate ?? '')
                : (pr?.creationDate ?? ''),
            merged_at:
                pr?.status === AzurePRStatus.COMPLETED
                    ? (pr?.closedDate ?? '')
                    : '',
            participants: [
                {
                    id: pr?.createdBy?.id ?? '',
                },
            ],
            reviewers:
                pr?.reviewers?.map((reviewer) => ({
                    id: reviewer?.id ?? '',
                })) || [],
            sourceRefName: pr?.sourceRefName ?? '', // TODO: remove, legacy, use head.ref
            head: {
                ref: pr?.sourceRefName?.replace('refs/heads/', ''),
                repo: {
                    id: pr?.repository?.id ?? '',
                    name: pr?.repository?.name ?? '',
                    defaultBranch: pr?.repository?.defaultBranch ?? '',
                    fullName: `${pr?.repository?.name ?? ''}/${pr?.sourceRefName?.replace('refs/heads/', '')}`,
                },
            },
            targetRefName: pr?.targetRefName ?? '', // TODO: remove, legacy, use base.ref
            base: {
                ref: pr?.targetRefName?.replace('refs/heads/', ''),
                repo: {
                    id: pr?.repository?.id ?? '',
                    name: pr?.repository?.name ?? '',
                    defaultBranch: pr?.repository?.defaultBranch ?? '',
                    fullName: `${pr?.repository?.name ?? ''}/${pr?.targetRefName?.replace('refs/heads/', '')}`,
                },
            },
            user: {
                login:
                    pr?.createdBy?.uniqueName ??
                    pr.createdBy?.displayName ??
                    '',
                name: pr?.createdBy?.displayName ?? '',
                id: pr?.createdBy?.id ?? '',
            },
            isDraft: pr?.isDraft ?? false,
        };
    }

    private transformRepositoryFile(file: AzureRepoFileItem): RepositoryFile {
        return {
            filename: file?.path?.split('/').pop() ?? '',
            sha: file?.objectId ?? '',
            path: file?.path ?? '',
            size: -1, // Size not available in Azure Repo FileItem
            type: file?.gitObjectType ?? 'blob',
        };
    }

    async createCommentInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        overallComment: string;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                overallComment,
            } = params;

            const { orgName, token } = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const projectId = await this.getProjectIdFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            // Criar um thread geral (não em arquivo específico)
            const response =
                await this.azureReposRequestHelper.createGeneralThread({
                    orgName,
                    token,
                    projectId,
                    repositoryId: repository.id,
                    prId: prNumber,
                    comment: overallComment,
                });

            this.logger.log({
                message: `Created general comment for PR#${prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService createCommentInPullRequest',
                metadata: {
                    repository: repository.name,
                    prNumber,
                },
            });

            return response;
        } catch (error) {
            this.logger.error({
                message: `Error creating general comment for PR#${params.prNumber}`,
                context: AzureReposService.name,
                serviceName: 'AzureReposService createCommentInPullRequest',
                error,
                metadata: {
                    repository: params.repository.name,
                    prNumber: params.prNumber,
                },
            });
            return null;
        }
    }
}
