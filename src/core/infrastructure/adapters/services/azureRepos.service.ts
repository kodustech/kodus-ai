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
import {
    CommentResult,
    FileChange,
    Repository,
    ReviewComment,
} from '@/config/types/general/codeReview.type';
import { IRepositoryManager } from '@/core/domain/repository/contracts/repository-manager.contract';
import { REPOSITORY_MANAGER_TOKEN } from '@/core/domain/repository/contracts/repository-manager.contract';
import { decrypt, encrypt } from '@/shared/utils/crypto';
import { generateWebhookToken } from '@/shared/utils/webhooks/webhookTokenCrypto';
import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import { Workflow } from '@/core/domain/platformIntegrations/types/codeManagement/workflow.type';

@IntegrationServiceDecorator(PlatformType.AZURE_REPOS, 'codeManagement')
export class AzureReposService
    implements Omit<ICodeManagementService, 'getOrganizations'>
{
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
    ) {}

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
    getChangedFilesSinceLastCommit(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    createReviewComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    createCommentInPullRequest(params: any): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }
    getRepositoryContentFile(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    getPullRequestByNumber(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    getCommitsForPullRequestForCodeReview(params: any): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }
    createIssueComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    createSingleIssueComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    updateIssueComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
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
    updateDescriptionInPullRequest(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
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
            this.logger?.error?.({
                message: 'Erro ao obter linguagens do repositório',
                context: 'AzureReposRequestHelper.getLanguageRepository',
                error,
                metadata: { ...params },
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
    getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        throw new Error('Method not implemented.');
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
                context: AzureReposService.name,
                error: error.message,
                metadata: params,
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
                context: AzureReposService.name,
                serviceName: 'AzureReposService getAuthDetails',
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
                context: AzureReposService.name,
                serviceName: 'AzureReposService.createWebhook',
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
                context: AzureReposService.name,
                serviceName: 'AzureReposService createAuthIntegration',
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
                context: AzureReposService.name,
                serviceName: 'AzureReposService authenticateWithToken',
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
                context: AzureReposService.name,
                error: error,
                metadata: params,
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
            console.log(error);
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
                context: AzureReposService.name,
                serviceName: 'AzureReposService getPullRequestsByRepository',
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

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !azureAuthDetail ||
                !repositories ||
                repositories.length === 0
            ) {
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
                    stateMap[pr.status?.toLowerCase()] || PullRequestState.ALL,
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
                context: AzureReposService.name,
                serviceName: 'AzureReposService getPullRequests',
                error: error,
                metadata: { params },
            });
            return [];
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
                context: 'AzureReposRequestHelper',
                serviceName: 'getPullRequestsWithFiles',
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
                context: AzureReposRequestHelper.name,
                serviceName: 'getCommits',
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

            const repo = await this.getRepoById(
                organizationAndTeamData,
                repository.id,
            );

            const pr = await this.azureReposRequestHelper.getPullRequestDetails(
                {
                    orgName,
                    token,
                    projectId: repo.project.id,
                    repositoryId: repo.id,
                    prId: prNumber,
                },
            );

            const iterations = await this.azureReposRequestHelper.getIterations(
                {
                    orgName,
                    token,
                    projectId: repo.project.id,
                    repositoryId: repo.id,
                    prId: prNumber,
                },
            );

            if (!iterations || iterations.length === 0) {
                return [];
            }

            const lastIteration = iterations[iterations.length - 1];
            const iterationId = lastIteration.id;

            const changes = await this.azureReposRequestHelper.getChanges({
                orgName,
                token,
                projectId: repo.project.id,
                repositoryId: repo.id,
                pullRequestId: pr.pullRequestId,
                iterationId,
            });

            const changeEntries = changes;

            const fileChanges: FileChange[] = await Promise.all(
                changeEntries
                    ?.filter((entry: any) => entry.item?.path)
                    ?.map(async (entry: any) => {
                        const filePath = entry.item.path;

                        const commitId = pr.lastMergeSourceCommit?.commitId;
                        ('');
                        let contents = '';
                        try {
                            contents = (
                                await this.azureReposRequestHelper.getFileContent(
                                    {
                                        orgName,
                                        token,
                                        projectId: repo.project.id,
                                        repositoryId: repo.id,
                                        filePath,
                                        commitId,
                                    },
                                )
                            )?.content;
                        } catch (err) {
                            contents = '';
                        }

                        let diffText = '';
                        const baseCommit =
                            pr.lastMergeTargetCommit?.commitId || '';
                        if (baseCommit && commitId) {
                            try {
                                const diffRes =
                                    await this.azureReposRequestHelper.getDiff({
                                        orgName,
                                        token,
                                        projectId: repo.project.id,
                                        repositoryId: repo.id,
                                        baseCommit,
                                        commitId,
                                        filePath,
                                    });
                                // Para simplificar, armazenamos o diff como JSON (você pode customizar o tratamento do diff se necessário)
                                diffText = JSON.stringify(diffRes);
                            } catch (err) {
                                diffText = '';
                            }
                        }

                        return {
                            filename: filePath,
                            sha: commitId,
                            status: entry.changeType,
                            additions: 0, // A API de changes do Azure não retorna as quantidades de linhas
                            deletions: 0,
                            changes: 0,
                            patch: diffText,
                            blob_url: null,
                            content: contents,
                            contents_url: null,
                            raw_url: null,
                        };
                    }),
            );

            return fileChanges;
        } catch (error) {
            this.logger.error({
                message: `Error to get files by pull request id: ${params.prNumber}`,
                context: AzureReposRequestHelper.name,
                serviceName: 'getFilesByPullRequestId',
                error: error,
                metadata: { params },
            });
            return null;
        }
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
                    status: true,
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
                context: AzureReposService.name,
                serviceName:
                    'AzureReposService findOneByOrganizationAndTeamDataAndConfigKey',
                error: err,
                metadata: {
                    organizationAndTeamData,
                    configKey,
                },
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
                    // AJUSTAR PARA O REPO ID
                    // repository: repoId,
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
                        sub.publisherInputs?.repository === repoId &&
                        sub.consumerInputs?.url?.includes(webhookUrl),
                );

                if (alreadyExists) {
                    this.logger.log({
                        message: `Webhook already exists for ${eventType}, id: ${alreadyExists.id}, will be removed`,
                        context: 'AzureReposService.createNotificationChannel',
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
                    message: `Webhook created for ${eventType}`,
                    context: 'AzureReposService.createNotificationChannel',
                    metadata: { subscriptionId: created?.id },
                });
            } catch (error) {
                this.logger.error({
                    message: `Error creating webhook for event ${eventType}`,
                    context: 'AzureReposService.createNotificationChannel',
                    error,
                    metadata: {
                        projectId,
                        repoId,
                        eventType,
                    },
                });
            }
        });

        const results = await Promise.allSettled(tasks);

        results.forEach((res, idx) => {
            const evt = eventTypes[idx];

            if (res.status === 'rejected') {
                this.logger.error({
                    message: `Error final in processing ${evt}`,
                    context: 'AzureReposService.createNotificationChannel',
                    error: res.reason,
                    metadata: {
                        projectId,
                        repoId,
                        eventType: evt,
                    },
                });
            }
        });
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
                })) ?? [],
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
                login: pr.createdBy?.uniqueName ?? '',
                name: pr.createdBy?.displayName,
                id: pr.createdBy?.id,
            },
        };
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
}
