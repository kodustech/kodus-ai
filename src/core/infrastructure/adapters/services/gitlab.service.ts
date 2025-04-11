import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import { DeployFrequency } from '@/core/domain/platformIntegrations/types/codeManagement/deployFrequency.type';
import {
    PullRequestCodeReviewTime,
    PullRequestDetails,
    PullRequestReviewComment,
    PullRequests,
    PullRequestsWithChangesRequested,
    PullRequestWithFiles,
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import {
    Gitlab,
    MergeRequestSchemaWithBasicLabels,
} from '@gitbeaker/rest';
import axios from 'axios';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { v4 as uuidv4 } from 'uuid';
import {
    INTEGRATION_SERVICE_TOKEN,
    IIntegrationService,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { GitlabAuthDetail } from '@/core/domain/authIntegrations/types/gitlab-auth-detail.type';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import { PinoLoggerService } from './logger/pino.service';
import { PromptService } from './prompt.service';
import { CommitLeadTimeForChange } from '@/core/domain/platformIntegrations/types/codeManagement/commitLeadTimeForChange.type';
import * as moment from 'moment-timezone';
import { Commit } from '@/config/types/general/commit.type';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import {
    GitlabPullRequestState,
    PullRequestState,
} from '@/shared/domain/enums/pullRequestState.enum';
import { AuthMode } from '@/core/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { decrypt, encrypt } from '@/shared/utils/crypto';
import { CodeManagementConnectionStatus } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@/shared/utils/translations/translations';
import { getLabelShield } from '@/shared/utils/codeManagement/labels';
import {
    IRepositoryManager,
    REPOSITORY_MANAGER_TOKEN,
} from '@/core/domain/repository/contracts/repository-manager.contract';
import { Repository } from '@/config/types/general/codeReview.type';
import { CreateAuthIntegrationStatus } from '@/shared/domain/enums/create-auth-integration-status.enum';
import { ReviewComment } from '@/config/types/general/codeReview.type';
import { getSeverityLevelShield } from '@/shared/utils/codeManagement/severityLevel';
import { getCodeReviewBadge } from '@/shared/utils/codeManagement/codeReviewBadge';

@Injectable()
@IntegrationServiceDecorator(PlatformType.GITLAB, 'codeManagement')
export class GitlabService
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

        private readonly promptService: PromptService,
        private readonly logger: PinoLoggerService,
    ) { }
    getPullRequestsWithChangesRequested(params: { organizationAndTeamData: OrganizationAndTeamData; repository: Partial<Repository>; }): Promise<PullRequestsWithChangesRequested[] | null> {
        throw new Error('Method not implemented.');
    }
    getListOfValidReviews(params: { organizationAndTeamData: OrganizationAndTeamData; repository: Partial<Repository>; prNumber: number; }): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }

    getPullRequestReviewThreads(params: { organizationAndTeamData: OrganizationAndTeamData; repository: Partial<Repository>; prNumber: number; }): Promise<PullRequestReviewComment[] | null> {
        throw new Error('Method not implemented.');
    }

    getRepositoryAllFiles(params: {
        repository: string;
        branch: string;
        organizationAndTeamData: OrganizationAndTeamData;
        filePatterns?: string[];
        excludePatterns?: string[];
        maxFiles?: number;
    }): Promise<any> {
        throw new Error('Method not implemented.');
    }

    getAuthenticationOAuthToken(params: any): Promise<string> {
        throw new Error('Method not implemented.');
    }

    getPullRequestDetails(params: any): Promise<PullRequestDetails | null> {
        throw new Error('Method not implemented.');
    }

    async getPullRequestByNumber(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<any | null> {
        try {
            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                throw new Error('GitLab authentication details not found');
            }

            const gitlab = await this.instanceGitlabApi(gitlabAuthDetail);

            // Since we already have the project ID, we can use it directly
            const projectId = params.repository.id;

            // Fetch the specific Merge Request
            const mergeRequest = await gitlab.MergeRequests.show(
                projectId,
                params.prNumber,
            );

            if (!mergeRequest) {
                return null;
            }

            // Returning in the same format as GitHub to maintain consistency
            return {
                number: mergeRequest.iid,
                title: mergeRequest.title,
                body: mergeRequest.description,
                state: mergeRequest.state,
                created_at: mergeRequest.created_at,
                updated_at: mergeRequest.updated_at,
                merged_at: mergeRequest.merged_at,
                head: {
                    ref: mergeRequest.source_branch,
                    repo: {
                        name: params.repository.name,
                        id: projectId,
                    },
                },
                base: {
                    ref: mergeRequest.target_branch,
                },
                user: {
                    login: mergeRequest.author.username,
                    id: mergeRequest.author.id,
                },
                assignees: mergeRequest.assignees,
                reviewers: mergeRequest.reviewers,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting merge request by number from GitLab',
                context: GitlabService.name,
                error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    private instanceGitlabApi(gitlabAuthDetail: GitlabAuthDetail) {
        return new Gitlab({
            oauthToken:
                gitlabAuthDetail.authMode === AuthMode.OAUTH
                    ? gitlabAuthDetail.accessToken
                    : decrypt(gitlabAuthDetail.accessToken),
            ...(gitlabAuthDetail.host && { host: gitlabAuthDetail.host }),
            queryTimeout: 600000,
        });
    }

    private async handleIntegration(
        integration: any,
        authDetails: any,
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

    async savePredictedDeploymentType(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }) {
        const integration = await this.integrationService.findOne({
            organization: {
                uuid: params.organizationAndTeamData.organizationId,
            },
            team: {
                uuid: params.organizationAndTeamData.teamId,
            },
            platform: PlatformType.GITLAB,
        });

        if (!integration) {
            return null;
        }

        const deploymentType = await this.predictDeploymentType(params);

        if (!deploymentType) {
            return null;
        }

        return await this.parameterService.createOrUpdateConfig(
            ParametersKey.DEPLOYMENT_TYPE,
            deploymentType,
            params.organizationAndTeamData,
        );
    }

    async predictDeploymentType(params: any) {
        try {
            const workflows = await this.getWorkflows(
                params.organizationAndTeamData,
            );

            if (workflows && workflows.length > 0) {
                return this.formatDeploymentTypeFromDeploy(workflows);
            }

            const releases = await this.getReleases(
                params.organizationAndTeamData,
            );

            if (releases && releases.length > 0) {
                return {
                    type: 'releases',
                    madeBy: 'Kody',
                };
            }

            const prs = await this.getPullRequests({
                organizationAndTeamData: params.organizationAndTeamData,
                filters: {
                    startDate: moment()
                        .subtract(90, 'days')
                        .format('YYYY-MM-DD'),
                    endDate: moment().format('YYYY-MM-DD'),
                },
            });

            if (prs && prs.length > 0) {
                return {
                    type: 'PRs',
                    madeBy: 'Kody',
                };
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing predict deployment type service',
                context: GitlabService.name,
                serviceName: 'PredictDeploymentType',
                error: error,
                metadata: {
                    teamId: params.organizationAndTeamData.teamId,
                },
            });
        }
    }

    async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.GITLAB,
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

            this.createMergeRequestWebhook({
                organizationAndTeamData: params.organizationAndTeamData,
            });
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async createAuthIntegration(
        params: any,
    ): Promise<{ success: boolean; status?: CreateAuthIntegrationStatus }> {
        try {
            let res: {
                success: boolean;
                status?: CreateAuthIntegrationStatus;
            } = {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
            if (params && params?.authMode === AuthMode.OAUTH) {
                res = await this.authenticateWithCodeOauth(params);
            } else if (params && params?.authMode === AuthMode.TOKEN) {
                res = await this.authenticateWithToken(params);
            }

            return res;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async authenticateWithCodeOauth(params: any): Promise<any> {
        try {
            const tokenResponse = await axios.post(
                process.env.API_GITLAB_TOKEN_URL,
                {
                    client_id: process.env.GLOBAL_GITLAB_CLIENT_ID,
                    client_secret: process.env.GLOBAL_GITLAB_CLIENT_SECRET,
                    code: params.code,
                    grant_type: 'authorization_code',
                    redirect_uri: process.env.GLOBAL_GITLAB_REDIRECT_URL,
                },
            );

            if (!tokenResponse || !tokenResponse.data) {
                throw new Error('Gitlab failed to generate auth token');
            }

            const authDetails = {
                accessToken: tokenResponse?.data?.access_token,
                refreshToken: tokenResponse?.data?.refresh_token,
                tokenType: tokenResponse?.data?.token_type,
                scope: tokenResponse?.data?.scope,
                authMode: params?.authMode || AuthMode.OAUTH,
            };

            const checkRepos = await this.checkRepositoryPermissions({
                authDetails: authDetails,
            });

            if (!checkRepos.success) return checkRepos;

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.GITLAB,
            });

            await this.handleIntegration(
                integration,
                authDetails,
                params.organizationAndTeamData,
            );

            return {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
        } catch (err) {
            throw new BadRequestException(
                err.message || 'Error authenticating with PAT.',
            );
        }
    }

    async authenticateWithToken(params: any): Promise<any> {
        try {
            let host = 'https://gitlab.com/api/v4/user';
            const { token, host: hostParam } = params;

            host = hostParam ? `${hostParam}/api/v4/user` : host;

            const testResponse = await axios.get(host, {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                timeout: 30000,
            });

            if (!testResponse || !testResponse.data) {
                throw new Error('GitLab failed to validate the PAT.');
            }

            const authDetails = {
                accessToken: encrypt(token),
                authMode: params?.authMode || AuthMode.OAUTH,
                host: hostParam ?? '',
            };

            const checkRepos = await this.checkRepositoryPermissions({
                authDetails: authDetails,
            });

            if (!checkRepos.success) return checkRepos;

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.GITLAB,
            });

            await this.handleIntegration(
                integration,
                authDetails,
                params.organizationAndTeamData,
            );

            return {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
        } catch (err) {
            throw new BadRequestException(
                'Error authenticating with GITLAB PAT.',
            );
        }
    }

    private async checkRepositoryPermissions(params: {
        authDetails: GitlabAuthDetail;
    }) {
        try {
            const { authDetails } = params;

            const gitlabAPI = this.instanceGitlabApi(authDetails);

            const projects = await gitlabAPI.Projects.all({
                perPage: 50,
                membership: true,
                statistics: true,
            });

            if (projects.length === 0) {
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
                context: GitlabService.name,
                error: error,
                metadata: params,
            });
            return {
                success: false,
                status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
            };
        }
    }

    async updateAuthIntegration(params: any): Promise<any> {
        await this.integrationService.update(
            {
                uuid: params.integrationId,
                authIntegration: params.authIntegrationId,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            },
            {
                status: true,
            },
        );

        return await this.authIntegrationService.update(
            {
                uuid: params.authIntegrationId,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            },
            {
                status: true,
                authDetails: params?.authDetails,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            },
        );
    }

    async getRepositories(params: any): Promise<Repositories[]> {
        try {
            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return [];
            }

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: params.organizationAndTeamData.teamId,
                },
                platform: PlatformType.GITLAB,
            });

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: params.organizationAndTeamData.teamId },
                });

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const projects = await gitlabAPI.Projects.all({
                perPage: 100,
                membership: true,
                statistics: true,
                simple: false,
                withCustomAttributes: true,
            });

            const repositories: Repositories[] = [];

            const batchSize = 30;

            for (let i = 0; i < projects?.length; i += batchSize) {
                const batch = projects.slice(i, i + batchSize);

                const batchResults = await Promise.all(
                    batch.map(async (project) => {
                        try {
                            if (project?.default_branch) {
                                return {
                                    id: project.id.toString(),
                                    name: project.path_with_namespace,
                                    http_url: project.http_url_to_repo,
                                    avatar_url: project.namespace?.avatar_url,
                                    organizationName: project.namespace?.name,
                                    visibility: (project?.visibility === 'public'
                                        ? 'public'
                                        : 'private') as 'public' | 'private',
                                    selected:
                                        integrationConfig?.configValue?.some(
                                            (repository: { name: string }) =>
                                                repository?.name ===
                                                project?.path_with_namespace,
                                        ),
                                    default_branch: project?.default_branch,
                                };
                            }

                            const projectDetails =
                                await gitlabAPI.Projects.show(project.id);

                            return {
                                id: project.id.toString(),
                                name: project.path_with_namespace,
                                http_url: project.http_url_to_repo,
                                avatar_url: project.namespace?.avatar_url,
                                organizationName: project.namespace?.name,
                                visibility: (project?.visibility === 'public'
                                    ? 'public'
                                    : 'private') as 'public' | 'private',
                                selected: integrationConfig?.configValue?.some(
                                    (repository: { name: string }) =>
                                        repository?.name ===
                                        project?.path_with_namespace,
                                ),
                                default_branch: projectDetails?.default_branch,
                            };
                        } catch (error) {
                            this.logger.warn({
                                message: `Failed to fetch details for project ${project?.id}`,
                                context: GitlabService.name,
                                error,
                                metadata: {
                                    projectId: project?.id,
                                    projectName: project?.path_with_namespace,
                                },
                            });

                            if (project?.default_branch) {
                                return {
                                    id: project.id.toString(),
                                    name: project.path_with_namespace,
                                    http_url: project.http_url_to_repo,
                                    avatar_url: project.namespace?.avatar_url,
                                    organizationName: project.namespace?.name,
                                    visibility: (project?.visibility === 'public'
                                        ? 'public'
                                        : 'private') as 'public' | 'private',
                                    selected: integrationConfig?.configValue?.some(
                                        (repository: { name: string }) =>
                                            repository?.name ===
                                            project?.path_with_namespace,
                                    ),
                                    default_branch: project?.default_branch,
                                };
                            }
                        }
                    }),
                );

                repositories.push(...batchResults);

                // Adicionar delay entre lotes para evitar rate limiting
                if (i + batchSize < projects?.length) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }

            return repositories;
        } catch (error) {
            this.logger.error({
                message: 'Failed to fetch GitLab repositories',
                context: GitlabService.name,
                error,
                metadata: {
                    organizationId:
                        params.organizationAndTeamData.organizationId,
                    teamId: params.organizationAndTeamData.teamId,
                },
            });
            throw new BadRequestException(error);
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
            if (!params?.organizationAndTeamData.organizationId) {
                return null;
            }

            const filters = params?.filters ?? {};
            const { startDate, endDate } = filters || {};

            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params?.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!gitlabAuthDetail || !repositories) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            let pullRequests = [];

            for (const repo of repositories) {
                const pr = await gitlabAPI.MergeRequests.all({
                    projectId: repo.id,
                    createdAfter: startDate, // TODO: remove
                    createdBefore: endDate,
                });

                pullRequests.push(
                    ...pr?.map((item) => ({
                        ...item,
                        repository: repo?.name,
                        repositoryId: repo?.id,
                    })),
                );
            }

            if (filters && filters?.state === 'open') {
                pullRequests = pullRequests.filter(
                    (pr: any) => pr.state === GitlabPullRequestState.OPENED,
                );
            }

            return pullRequests
                .sort((a, b) => {
                    return (
                        new Date(b.created_at).getTime() -
                        new Date(a.created_at).getTime()
                    );
                })
                .map((pr: MergeRequestSchemaWithBasicLabels) => ({
                    id: pr.id?.toString(),
                    author_id: pr.author?.id.toString(),
                    author_name: pr.author?.name,
                    author_created_at: pr.created_at,
                    repository: (pr?.repository as string) ?? '',
                    repositoryId: (pr?.repositoryId as string) ?? '',
                    message: pr.description,
                    state:
                        pr.state === GitlabPullRequestState.OPENED
                            ? PullRequestState.OPENED
                            : pr.state === GitlabPullRequestState.CLOSED
                                ? PullRequestState.CLOSED
                                : PullRequestState.ALL,
                    pull_number: pr.iid,
                    project_id: pr.project_id,
                    prURL: pr.web_url,
                    organizationId:
                        params?.organizationAndTeamData?.organizationId,
                }));
        } catch (error) {
            console.log(error);
            return [];
        }
    }

    async getCommits(params: any): Promise<Commit[]> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return null;
            }

            const filters = params?.filters ?? {};

            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params?.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!gitlabAuthDetail || !repositories) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const { startDate, endDate } = filters || {};

            const commits = [];

            for (const repo of repositories) {
                const repoCommits = await gitlabAPI.Commits.all(repo.id, {
                    since: startDate,
                    until: endDate,
                    perPage: 100,
                });

                commits.push(...repoCommits);
            }

            const commitsFormatted = commits
                .sort(
                    (a, b) =>
                        new Date(b.created_at).getTime() -
                        new Date(a.created_at).getTime(),
                )
                .map((item) => ({
                    sha: item.sha,
                    commit: {
                        author: {
                            id: item.commit.author.id,
                            name: item.commit.author.name,
                            email: item.commit.author.email,
                            date: item.commit.author.date,
                        },
                        message: item.commit.message,
                    },
                }));

            return commitsFormatted;
        } catch (error) {
            console.error('Error fetching commits from GitLab: ', error);
            return [];
        }
    }

    async getListMembers(
        params: any,
    ): Promise<{ name: string; id: string | number }[]> {
        const gitlabAuthDetail = await this.getAuthDetails(
            params.organizationAndTeamData,
        );

        if (!gitlabAuthDetail) {
            return [];
        }

        const integration = await this.integrationService.findOne({
            organization: {
                uuid: params.organizationAndTeamData.organizationId,
            },
            team: {
                uuid: params.organizationAndTeamData.teamId,
            },
            platform: PlatformType.GITLAB,
        });

        const integrationConfig = await this.integrationConfigService.findOne({
            integration: { uuid: integration?.uuid },
            configKey: IntegrationConfigKey.REPOSITORIES,
            team: { uuid: params.organizationAndTeamData.teamId },
        });

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const repositories = integrationConfig.configValue;
        const users = [];

        for (const repository of repositories) {
            users.push(...(await gitlabAPI.Projects.allUsers(repository.id)));
        }

        // Removing duplicates based on a unique identifier, such as 'id'
        const uniqueUsersMap = new Map();
        for (const user of users) {
            if (!uniqueUsersMap.has(user.id)) {
                uniqueUsersMap.set(user.id, user);
            }
        }

        const uniqueUsers = Array.from(uniqueUsersMap.values());

        return uniqueUsers.map((user) => {
            return {
                name: user.name,
                id: user.id,
            };
        });
    }

    async verifyConnection(
        params: any,
    ): Promise<CodeManagementConnectionStatus> {
        try {
            if (!params.organizationAndTeamData.organizationId)
                return {
                    platformName: PlatformType.GITLAB,
                    isSetupComplete: false,
                    hasConnection: false,
                    config: {},
                };

            const [gitlabRepositories, gitlabOrg] = await Promise.all([
                this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                ),
                this.integrationService.findOne({
                    organization: {
                        uuid: params.organizationAndTeamData.organizationId,
                    },
                    status: true,
                    platform: PlatformType.GITLAB,
                }),
            ]);

            const hasRepositories = gitlabRepositories?.length > 0;

            const authMode = gitlabOrg?.authIntegration?.authDetails?.authMode
                ? gitlabOrg?.authIntegration?.authDetails?.authMode
                : AuthMode.OAUTH;

            const isSetupComplete =
                (!!hasRepositories &&
                    authMode === AuthMode.OAUTH &&
                    !!gitlabOrg?.authIntegration?.authDetails.accessToken) ||
                (authMode === AuthMode.TOKEN &&
                    !!gitlabOrg?.authIntegration?.authDetails?.accessToken);

            return {
                platformName: PlatformType.GITLAB,
                isSetupComplete,
                hasConnection: !!gitlabOrg,
                config: {
                    hasRepositories: hasRepositories,
                    status: gitlabRepositories?.installationStatus,
                },
                category: IntegrationCategory.CODE_MANAGEMENT,
            };
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async addAccessToken(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails: any,
    ): Promise<IntegrationEntity> {
        const authUuid = uuidv4();

        const authIntegration = await this.authIntegrationService.create({
            uuid: authUuid,
            status: true,
            authDetails,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        return this.addIntegration(
            organizationAndTeamData,
            authIntegration?.uuid,
        );
    }

    async addIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
        authIntegrationId: string,
    ): Promise<IntegrationEntity> {
        const integrationUuid = uuidv4();

        return this.integrationService.create({
            uuid: integrationUuid,
            platform: PlatformType.GITLAB,
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            authIntegration: { uuid: authIntegrationId },
        });
    }

    async getAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<GitlabAuthDetail> {
        const gitlabAuthDetail =
            await this.integrationService.getPlatformAuthDetails<GitlabAuthDetail>(
                organizationAndTeamData,
                PlatformType.GITLAB,
            );

        return {
            ...gitlabAuthDetail,
            authMode: gitlabAuthDetail?.authMode || AuthMode.OAUTH,
        };
    }

    async getWorkflows(organizationAndTeamData: OrganizationAndTeamData) {
        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const repositories = <Repositories[]>(
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            )
        );

        if (!gitlabAuthDetail || !repositories) {
            return null;
        }

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const workflows = [];

        for (const repo of repositories) {
            const workflowsFromRepo = await gitlabAPI.Pipelines.all(repo.id);

            if (workflowsFromRepo.length <= 0) continue;

            workflows.push({
                repo: repo,
                workflows: workflowsFromRepo,
            });
        }

        if (!workflows || workflows.length <= 0) {
            return [];
        }

        let llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_TURBO,
            ),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const promptWorkflows =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_getProductionWorkflows',
                {
                    organizationAndTeamData,
                    payload: JSON.stringify(workflows),
                    promptIsForChat: false,
                },
            );

        const chain = await llm.invoke(promptWorkflows, {
            metadata: {
                module: 'Setup',
                submodule: 'GetProductionDeployment',
            },
        });

        return safelyParseMessageContent(chain.content).repos;
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
                platform: PlatformType.GITLAB,
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
            throw new BadRequestException(err);
        }
    }

    private formatDeploymentTypeFromDeploy(workflows) {
        return {
            type: 'deployment',
            madeBy: 'Kody',
            value: {
                workflows: workflows.flatMap((repo) =>
                    repo.productionWorkflows.map((workflow) => ({
                        id: workflow.id,
                        name: workflow.name,
                        repo: repo.repo,
                    })),
                ),
            },
        };
    }

    async getReleases(organizationAndTeamData: OrganizationAndTeamData) {
        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const repositories = <Repositories[]>(
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            )
        );

        if (!gitlabAuthDetail || !repositories) {
            return null;
        }

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const releases = [];

        for (const repo of repositories) {
            const releasesFromRepo = await gitlabAPI.ProjectReleases.all(
                repo.id,
            );

            releases.push({
                repo: repo,
                releases: releasesFromRepo.filter((release) => {
                    return (
                        moment().diff(moment(release.created_at), 'days') <= 90
                    );
                }),
            });
        }

        if (!releases || releases.length <= 0) {
            return [];
        }

        let llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_TURBO,
            ),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const promptReleases =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_getProductionReleases',
                {
                    organizationAndTeamData,
                    payload: JSON.stringify(releases),
                    promptIsForChat: false,
                },
            );

        const chain = await llm.invoke(promptReleases, {
            metadata: {
                module: 'Setup',
                submodule: 'GetProductionReleases',
            },
        });

        const repos = safelyParseMessageContent(chain.content).repos;

        if (
            repos.filter((repo) => {
                return repo.productionReleases;
            }).length <= 0
        ) {
            return [];
        }

        return repos;
    }

    async getMergeRequestFromRepository(
        gitlab: InstanceType<typeof Gitlab>,
        projectId: string,
        startDate?: string,
        endDate?: string,
        state: string = 'all',
    ): Promise<any[]> {
        const options: any = {
            projectId,
            sort: 'desc',
            createdAfter: startDate,
            createdBefore: endDate,
        };

        if (state !== 'all' && state !== null) {
            options.state = state;
        }

        return await gitlab.MergeRequests.all(options);
    }

    async getPullRequestsWithFiles(
        params: any,
    ): Promise<PullRequestWithFiles[] | null> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return null;
            }

            const filters = params?.filters ?? {};
            const { startDate, endDate } = filters?.period || {};
            const prStatus = filters?.prStatus || 'all';

            const gitlabAuthDetail = await this.getAuthDetails(
                params?.organizationAndTeamData,
            );

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params?.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!gitlabAuthDetail || !repositories) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const pullRequestsWithFiles: PullRequestWithFiles[] = [];

            for (const repo of repositories) {
                const mergeRequests = await this.getMergeRequestFromRepository(
                    gitlabAPI,
                    repo.id,
                    startDate,
                    endDate,
                    prStatus,
                );

                const pullRequestDetails = await Promise.all(
                    mergeRequests.map(async (pullRequest) => {
                        const filesWithChanges =
                            await this.countChangesInMergeRequest(
                                gitlabAPI,
                                repo.id,
                                pullRequest.iid,
                            );

                        return {
                            id: pullRequest.id,
                            pull_number: pullRequest.number ?? pullRequest.iid,
                            state: pullRequest.state,
                            title: pullRequest.title,
                            repository: repo,
                            pullRequestFiles: filesWithChanges, // Includes the files with changes
                        };
                    }),
                );

                pullRequestsWithFiles.push(...pullRequestDetails);
            }

            return pullRequestsWithFiles;
        } catch (error) {
            console.log(error);
        }
    }

    getCommitsByReleaseMode(params: any): Promise<CommitLeadTimeForChange[]> {
        throw new Error('Method not implemented.');
    }

    getDataForCalculateDeployFrequency(
        params: any,
    ): Promise<DeployFrequency[]> {
        throw new Error('Method not implemented.');
    }

    private async getPullRequestFiles(
        gitlab: InstanceType<typeof Gitlab>,
        projectId: string,
        merge_number: number,
    ): Promise<any> {
        const files = await gitlab.MergeRequests.allDiffs(
            projectId,
            merge_number,
        );

        return files;
    }

    async countChangesInMergeRequest(
        gitlab: InstanceType<typeof Gitlab>,
        projectId: string,
        mergeNumber: number,
    ): Promise<any[]> {
        const files = await this.getPullRequestFiles(
            gitlab,
            projectId,
            mergeNumber,
        );

        return files.map((file) => {
            const result = this.countChanges(file.diff);
            const changes = result.adds + result.deletes;

            return {
                changes,
            };
        });
    }

    private countChanges(diff: string): { adds: number; deletes: number } {
        const lines = diff.split('\n');
        let adds = 0;
        let deletes = 0;

        lines.forEach((line) => {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                adds++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                deletes++;
            }
        });

        return { adds, deletes };
    }

    async getPullRequestsForRTTM(
        params: any,
    ): Promise<PullRequestCodeReviewTime[] | null> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return null;
            }

            const filters = params?.filters ?? {};
            const { startDate, endDate } = filters?.period || {};

            const gitlabAuthDetail = await this.getAuthDetails(
                params?.organizationAndTeamData,
            );

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params?.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!gitlabAuthDetail || !repositories) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const pullRequestCodeReviewTime: PullRequestCodeReviewTime[] = [];

            for (const repo of repositories) {
                const mergeRequests = await this.getMergeRequestFromRepository(
                    gitlabAPI,
                    repo.id,
                    startDate,
                    endDate,
                    'closed',
                );

                const pullRequestsFormatted = mergeRequests?.map(
                    (pullRequest) => ({
                        id: pullRequest.id,
                        created_at: pullRequest.created_at,
                        closed_at: pullRequest.merged_at,
                    }),
                );

                pullRequestCodeReviewTime.push(...pullRequestsFormatted);
            }

            return pullRequestCodeReviewTime;
        } catch (error) {
            console.log(error);
        }
    }

    async getFilesByPullRequestId(params: any): Promise<any[] | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const files = await this.getPullRequestFiles(
            gitlabAPI,
            repository.id,
            prNumber,
        );

        return files.map((file) => {
            const changeCount = this.countChanges(file.diff);
            return {
                filename: file.new_path,
                sha: file?.sha ?? null,
                status: this.mapGitlabStatus(file),
                additions: changeCount.adds,
                deletions: changeCount.deletes,
                changes: changeCount.adds + changeCount.deletes,
                patch: file.diff,
            };
        });
    }

    async getChangedFilesSinceLastCommit(params: any) {
        const { organizationAndTeamData, repository, prNumber, lastCommit } =
            params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const commits = await gitlabAPI.MergeRequests.allCommits(
            repository.id,
            prNumber,
        );

        const changedFiles = [];

        const newCommits = commits.filter(
            (commit) =>
                new Date(commit.created_at) > new Date(lastCommit.created_at),
        );

        for (const commit of newCommits) {
            const commitDiff = await gitlabAPI.Commits.showDiff(
                repository.id,
                commit.id,
            );
            changedFiles.push(...commitDiff);
        }

        return changedFiles.map((file) => {
            const changeCount = this.countChanges(file.diff);

            return {
                filename: file.new_path,
                status: this.mapGitlabStatus(file),
                additions: changeCount.adds,
                deletions: changeCount.deletes,
                changes: changeCount.adds + changeCount.deletes,
                patch: file.diff,
            };
        });
    }

    /*************  ✨ Codeium Command ⭐  *************/
    /**
     * Maps the GitLab commit status to a standard status.
     *
     * Returns 'added', 'removed', 'renamed', or 'modified'.
     *
     * @param change - The commit change object.
     * @returns The mapped status.
     */
    private mapGitlabStatus(change: any): string {
        if (change.new_file) {
            return 'added';
        }
        if (change.deleted_file) {
            return 'removed';
        }
        if (change.renamed_file) {
            return 'renamed';
        }

        return 'modified';
    }

    formatCodeBlock(language: string, code: string) {
        return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    formatSub(text: string) {
        return `<sub>${text}</sub>\n\n`;
    }

    formatBodyForGitLab(lineComment: any, repository: any, translations: any) {
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
    async createReviewComment(params: any): Promise<ReviewComment | null> {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
            lineComment,
            commit,
            language,
        } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        try {
            // 1. Retrieve the MR versions to determine the `baseSha` and `startSha`
            const versions = await gitlabAPI.MergeRequests.allDiffVersions(
                repository.id,
                prNumber,
            );

            // 2. The `baseSha` usually comes from the `base_commit_sha` of the first version
            const baseSha = versions[0].base_commit_sha;

            // 3. The `startSha` is typically the first commit of the diff in the first version
            const startSha = versions[0].start_commit_sha;
            const translations = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.ReviewComment,
            );

            const bodyFormatted = this.formatBodyForGitLab(
                lineComment,
                repository,
                translations,
            );

            const discussion = await gitlabAPI.MergeRequestDiscussions.create(
                repository.id,
                prNumber,
                bodyFormatted,
                {
                    position: {
                        positionType: 'text',
                        baseSha: baseSha,
                        startSha: startSha,
                        headSha: commit?.sha,
                        newPath: lineComment.path,
                        newLine: lineComment.start_line
                            ? lineComment.start_line
                            : lineComment.line,
                        endLine: lineComment.start_line
                            ? lineComment.line
                            : null,
                    },
                },
            );

            this.logger.log({
                message: `Created line comment for PR#${prNumber}`,
                context: GitlabService.name,
                metadata: { ...params },
            });

            return {
                id: discussion?.notes[0]?.id,
                pullRequestReviewId: discussion?.id,
                body: discussion?.notes[0]?.body,
                createdAt: discussion?.notes[0]?.created_at,
                updatedAt: discussion?.notes[0]?.updated_at,
            };
        } catch (error) {
            const isLineMismatch = error.cause.description.includes(
                'must be a valid line code',
            );

            const errorType = isLineMismatch
                ? 'failed_lines_mismatch'
                : 'failed';

            this.logger.error({
                message: `Error creating line comment for PR#${prNumber}`,
                context: GitlabService.name,
                error: error,
                metadata: {
                    ...params,
                    errorType,
                },
            });

            throw {
                ...error,
                errorType,
            };
        }
    }

    async createIssueComment(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, body } =
                params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            // Create the comment in the Merge Request
            const response = await gitlabAPI.MergeRequestDiscussions.create(
                repository.id,
                prNumber,
                body,
            );

            return response;
        } catch (error) {
            this.logger.error({
                message: 'Error creating the comment:',
                context: GitlabService.name,
                serviceName: 'GitlabService createIssueComment',
                error: error,
                metadata: {
                    ...params,
                },
            });
        }
    }

    async createSingleIssueComment(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, body } =
                params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            // Create the comment in the Merge Request
            const response = await gitlabAPI.MergeRequestNotes.create(
                repository.id,
                prNumber,
                body,
            );

            return response;
        } catch (error) {
            this.logger.error({
                message: 'Error creating the comment:',
                context: GitlabService.name,
                serviceName: 'GitlabService createIssueComment',
                error: error,
                metadata: {
                    ...params,
                },
            });
        }
    }

    async createCommentInPullRequest(params: any): Promise<any | null> {
        const { organizationAndTeamData, repository, prNumber, body } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        // const response = (await octokit.rest.pulls.createReview({
        //     owner: gitlabAuthDetail?.org,
        //     repo: repository.name,
        //     pull_number: prNumber,
        //     body: body,
        //     event: 'COMMENT',
        //     comments: lineComments,
        // })) as any;

        return null;
    }

    async getRepositoryContentFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        file: any;
        pullRequest: any;
    }): Promise<any | null> {
        const gitlabAuthDetail = await this.getAuthDetails(
            params.organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        try {
            const fileContent = await gitlabAPI.RepositoryFiles.show(
                params?.repository?.id,
                params.file?.filename,
                params?.pullRequest?.head?.ref,
            );

            return {
                data: {
                    content: fileContent.content,
                    encoding: 'base64',
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error fetching file content from GitLab',
                context: GitlabService.name,
                error,
                metadata: { repository: params.repository, file: params.file },
            });
            return null;
        }
    }

    private shouldIndexRepositories(params: any): boolean {
        return (
            params.configKey === IntegrationConfigKey.REPOSITORIES &&
            params?.configValue?.length > 0
        );
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
            throw new BadRequestException(err);
        }
    }

    async updateIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string };
        prNumber: number;
        commentId: string;
        body: string;
        noteId?: number;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                commentId,
                body,
                noteId,
            } = params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            // Update the comment in the Merge Request
            const response = await gitlabAPI.MergeRequestDiscussions.editNote(
                repository.id,
                prNumber,
                commentId,
                noteId,
                { body: body },
            );

            return response;
        } catch (error) {
            this.logger.error({
                message: 'Error updating the comment:',
                context: GitlabService.name,
                serviceName: 'GitlabService updateIssueComment',
                error: error,
                metadata: {
                    ...params,
                },
            });
            throw error;
        }
    }

    async getCommitsForPullRequestForCodeReview(
        params: any,
    ): Promise<any[] | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const commits = await gitlabAPI.MergeRequests.allCommits(
            repository.id,
            prNumber,
        );

        const commitDetails = await Promise.all(
            commits.map(async (commit) => {
                const user = await this.getUserByEmailOrName({
                    organizationAndTeamData,
                    email: commit?.author_email,
                    userName: commit?.author_name,
                });

                return {
                    sha: commit?.id,
                    message: commit?.message,
                    created_at: commit?.created_at,
                    author: {
                        name: commit?.author_name,
                        email: commit?.author_email,
                        date: commit?.authored_date,
                        username: user ? user.username : null,
                        id: user && user.id ? user.id : null,
                    },
                };
            }),
        );

        return commitDetails.sort((a, b) => {
            return (
                new Date(a?.created_at).getTime() -
                new Date(b?.created_at).getTime()
            );
        });
    }

    async createMergeRequestWebhook(params: any) {
        const { organizationAndTeamData } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const repositories = <Repositories[]>(
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                params?.organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            )
        );

        const webhookUrl = process.env.API_GITLAB_CODE_MANAGEMENT_WEBHOOK; // Replace with your webhook URL

        try {
            for (const repo of repositories) {
                const existingHooks = await gitlabAPI.ProjectHooks.all(repo.id);

                const hookExists = existingHooks.some(
                    (hook) => hook.url === webhookUrl,
                );

                if (!hookExists) {
                    await gitlabAPI.ProjectHooks.add(repo.id, webhookUrl, {
                        mergeRequestsEvents: true,
                        enableSslVerification: true,
                        noteEvents: true,
                        issuesEvents: true,
                        pushEvents: false,
                    });
                    console.log(`Webhook added to project ${repo.id}`);
                } else {
                    console.log(`Webhook already exists in project ${repo.id}`);
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error creating webhook:',
                context: GitlabService.name,
                serviceName: 'GitlabService createMergeRequestWebhook',
                error: error,
                metadata: {
                    ...params,
                },
            });
            throw error;
        }
    }

    async getPullRequestReviewComment(params: any): Promise<any | null> {
        const { organizationAndTeamData, filters } = params;

        try {
            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const comments = await gitlabAPI.MergeRequestDiscussions.all(
                filters.repository.id,
                filters.pullRequestNumber,
            );

            const originalCommit = comments?.find(
                (comment) => comment.id === filters.discussionId,
            )?.notes[0]?.body;

            if (filters?.discussionId === undefined) {
                return comments;
            } else {
                return comments
                    ?.filter((comment) => comment.id === filters.discussionId)
                    .flatMap((comment) =>
                        comment.notes.map((note) => ({
                            id: note.id,
                            body: note.body,
                            createdAt: note.created_at,
                            originalCommit: { body: originalCommit },
                            author: {
                                id: note.author.id,
                                username: note.author.username,
                                name: note.author.name,
                            },
                        })),
                    )
                    .sort(
                        (a, b) =>
                            new Date(b.createdAt).getTime() -
                            new Date(a.createdAt).getTime(),
                    );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull request comments:',
                context: GitlabService.name,
                serviceName: 'GitlabService getPullRequestReviewComment',
                error: error,
                metadata: {
                    ...params,
                },
            });
            throw error;
        }
    }

    async getDefaultBranch(params: any): Promise<string> {
        const { organizationAndTeamData, repository } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const project = await gitlabAPI.Projects.show(repository.id);

        return project?.default_branch;
    }

    async updateDescriptionInPullRequest(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, summary } =
                params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            await gitlabAPI.MergeRequests.edit(repository.id, prNumber, {
                description: summary, // Set the new description here
            });
        } catch (error) {
            this.logger.error({
                message: 'Error update description in pull request:',
                context: GitlabService.name,
                serviceName: 'GitlabService updateDescriptionInPullRequest',
                error: error,
                metadata: {
                    ...params,
                },
            });
            throw error;
        }
    }

    async createResponseToComment(params: any): Promise<any | null> {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
            body,
            inReplyToId,
            discussionId,
        } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        try {
            const response = await gitlabAPI.MergeRequestDiscussions.addNote(
                repository.id,
                prNumber,
                discussionId,
                inReplyToId,
                body,
            );

            return response;
        } catch (error) {
            console.error('Error creating response to comment:', error);
            return null;
        }
    }

    async countReactions(params: any) {
        const { comments, pr, organizationAndTeamData } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );
        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        const commentsWithReactions = await Promise.all(
            comments
                .filter((comment) => comment.notes?.length > 0)
                .map(async (comment) => {
                    try {
                        const awards =
                            await gitlabAPI.MergeRequestNoteAwardEmojis.all(
                                comment.notes[0].project_id,
                                comment.notes[0].noteable_iid,
                                comment.notes[0].id,
                            );

                        const thumbsUp = awards.filter((a) =>
                            a.name.startsWith('thumbsup'),
                        ).length;
                        const thumbsDown = awards.filter((a) =>
                            a.name.startsWith('thumbsdown'),
                        ).length;

                        return {
                            ...comment,
                            notes: [
                                {
                                    ...comment.notes[0],
                                    reactions: {
                                        thumbsUp: thumbsUp,
                                        thumbsDown: thumbsDown,
                                    },
                                },
                            ],
                        };
                    } catch (error) {
                        console.error('Error fetching awards:', error);
                        return comment;
                    }
                }),
        );

        return commentsWithReactions
            .filter((comment) => {
                const reactions = comment.notes[0].reactions || {
                    thumbsUp: 0,
                    thumbsDown: 0,
                };
                return reactions.thumbsUp > 0 || reactions.thumbsDown > 0;
            })
            .map((comment) => ({
                reactions: comment.notes[0].reactions || {
                    thumbsUp: 0,
                    thumbsDown: 0,
                },
                comment: {
                    id: comment.notes[0].id,
                    body: comment.notes[0].body,
                    pull_request_review_id: comment.id,
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
    }

    async getLanguageRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository } = params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const languages = await gitlabAPI.Projects.showLanguages(
                repository.id,
            );

            // If there is no data or if it's empty, return null
            if (!languages || !Object.keys(languages).length) {
                return null;
            }

            // Converting to an array of [language, percentage]
            // and finding the one with the highest percentage
            let [maxLang, maxValue] = Object.entries(languages)[0];
            for (const [lang, value] of Object.entries(languages)) {
                if (value > maxValue) {
                    maxValue = value;
                    maxLang = lang;
                }
            }

            return maxLang;
        } catch (error) {
            console.error('Error fetching languages:', error);
            return null;
        }
    }

    async mergePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }) {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            await gitlabAPI.MergeRequests.merge(repository.id, prNumber);

            this.logger.log({
                message: `Merged pull request #${prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService mergePullRequest',
                metadata: params,
            });
        } catch (error) {
            this.logger.error({
                message: `Error to merge pull request #${params.prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService mergePullRequest',
                error: error,
                metadata: params,
            });
            return null;
        }
    }

    async cloneRepository(params: {
        repository: Pick<
            Repository,
            'id' | 'defaultBranch' | 'fullName' | 'name'
        >;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<string> {
        try {
            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                throw new Error('GitLab authentication details not found');
            }

            // Construct the full GitLab URL
            const fullGitlabUrl = `https://gitlab.com/${params?.repository?.fullName}`;

            const repoPath = await this.repositoryManager.gitCloneWithAuth({
                organizationId: params.organizationAndTeamData.organizationId,
                repositoryId: params.repository?.id,
                repositoryName: params.repository?.name,
                url: fullGitlabUrl,
                provider: PlatformType.GITLAB,
                branch: params.repository?.defaultBranch,
                auth: {
                    type: gitlabAuthDetail.authMode,
                    token:
                        gitlabAuthDetail.authMode === AuthMode.OAUTH
                            ? gitlabAuthDetail.accessToken
                            : decrypt(gitlabAuthDetail.accessToken),
                },
            });

            return repoPath;
        } catch (error) {
            this.logger.error({
                message: `Failed to clone repository ${params?.repository?.fullName} from Gitlab`,
                context: GitlabService.name,
                serviceName: 'GitlabService cloneRepository',
                error: error,
                metadata: {
                    ...params,
                },
            });
            throw error;
        }
    }

    async approvePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }) {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            await gitlabAPI.MergeRequestApprovals.approve(
                repository.id,
                prNumber,
            );

            this.logger.log({
                message: `Approved pull request #${prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService approvePullRequest',
                metadata: params,
            });
        } catch (error) {
            // if we already approved this will throw an error 401 unauthorized
            this.logger.error({
                message: `Error to approve pull request #${params.prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService approvePullRequest',
                error: error,
                metadata: params,
            });
            return null;
        }
    }

    async requestChangesPullRequest(params: any) {
        this.logger.error({
            message: `Request changes pull request not implemented`,
            context: GitlabService.name,
            serviceName: 'GitlabService requestChangesPullRequest',
            metadata: params,
        });
        throw new Error('Method not implemented.');
    }

    async getAllCommentsInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }) {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const discussions = await gitlabAPI.MergeRequestDiscussions.all(
                repository.id,
                prNumber,
            );

            return discussions.flatMap((discussion) => discussion.notes);
        } catch (error) {
            this.logger.error({
                message: 'Error to get all comments in pull request',
                context: GitlabService.name,
                serviceName: 'GitlabService getAllCommentsInPullRequest',
                error: error.message,
                metadata: params,
            });
            return [];
        }
    }

    async getUserByEmailOrName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        email: string;
        userName: string;
    }): Promise<any | null> {
        try {
            const { userName, email, organizationAndTeamData } = params;

            if (!email && !userName) {
                return null;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            if (email) {
                const usersByEmail = await gitlabAPI.Users.all({
                    search: email,
                });
                const exactMatchUserByEmail = usersByEmail.find(
                    (user) => user.email === email,
                );
                if (exactMatchUserByEmail) {
                    return exactMatchUserByEmail;
                }
            }

            if (userName) {
                const users = await gitlabAPI.Users.all({ search: userName });

                const exactMatchUser = users.find(
                    (user) => user.name === userName,
                );

                return exactMatchUser || null;
            }
        } catch (error) {
            this.logger.error({
                message: `Error retrieving user by email or name: ${params.email || params.userName}`,
                context: GitlabService.name,
                serviceName: 'GitlabService getUserByEmailOrName',
                error: error,
                metadata: params,
            });
            return null;
        }
    }

    async getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any> {
        const { username, organizationAndTeamData } = params;

        try {
            if (!username) {
                return null;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const users = await gitlabAPI.Users.all({ search: username });
            const exactMatchUser = users.find(
                (user) => user.username === username,
            );

            return exactMatchUser || null;
        } catch (error) {
            if (error?.response?.status === 404) {
                this.logger.warn({
                    message: `Gitlab user not found: ${username}`,
                    context: GitlabService.name,
                    metadata: { username, organizationAndTeamData },
                });
                return null;
            }

            this.logger.error({
                message: `Error retrieving user by username: ${params.username}`,
                context: GitlabService.name,
                serviceName: 'GitlabService getUserByUsername',
                error: error,
                metadata: params,
            });
            return null;
        }
    }

    async getUserById(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        userId: string;
    }): Promise<any | null> {
        try {
            const { userId, organizationAndTeamData } = params;

            if (!userId) {
                return null;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const user = await gitlabAPI.Users.show(Number(userId));

            return user || null;
        } catch (error) {
            this.logger.error({
                message: `Error retrieving user by ID: ${params.userId}`,
                context: GitlabService.name,
                serviceName: 'GitlabService getUserById',
                error: error,
                metadata: params,
            });
            return null;
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
    }): Promise<any[]> {
        try {
            const { organizationAndTeamData, repository, filters } = params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const mergeRequests = await gitlabAPI.MergeRequests.all({
                projectId: repository.id,
                createdAfter: filters?.startDate,
                createdBefore: filters?.endDate,
            });

            return mergeRequests.map(
                (pr: MergeRequestSchemaWithBasicLabels) => ({
                    id: pr.id?.toString(),
                    author_id: pr.author?.id.toString(),
                    author_name: pr.author?.name,
                    author_created_at: pr.created_at,
                    repository: repository.name,
                    repositoryId: repository.id,
                    message: pr.description,
                    state:
                        pr.state === GitlabPullRequestState.OPENED
                            ? PullRequestState.OPENED
                            : pr.state === GitlabPullRequestState.CLOSED
                                ? PullRequestState.CLOSED
                                : PullRequestState.ALL,
                    pull_number: pr.iid,
                    project_id: pr.project_id,
                    prURL: pr.web_url,
                    organizationId:
                        params?.organizationAndTeamData?.organizationId,
                }),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests by repository',
                context: GitlabService.name,
                serviceName: 'GitlabService getPullRequestsByRepository',
                error: error.message,
                metadata: params,
            });
            return null;
        }
    }

    async getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Partial<Repository>,
        prNumber: number,
    }): Promise<PullRequestReviewComment[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const projectId = repository.id;
            const mergeRequestIid = prNumber;

            if (!projectId || !mergeRequestIid) {
                return null;
            }

            const gitlabAuthDetail = await this.getAuthDetails(organizationAndTeamData);

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const discussions = await gitlabAPI.MergeRequestDiscussions.all(projectId, mergeRequestIid);

            const validRequestReviews = discussions
                .filter((discussion) => {
                    const firstDiscussionComment = discussion.notes[0];
                    return firstDiscussionComment.resolvable &&
                        !firstDiscussionComment.body.includes("## Code Review Completed! 🔥"); // Exclude comments with the specific string
                })
                .map((discussion) => {
                    // The review comment will always be the first one.
                    const firstDiscussionComment = discussion.notes[0];
                    const isDiscussionResolved: boolean = (firstDiscussionComment.resolved && firstDiscussionComment.resolved === true) ? (true) : (false);

                    const comment: PullRequestReviewComment = {
                        id: firstDiscussionComment.id,
                        threadId: discussion.id,
                        body: firstDiscussionComment.body ?? "",
                        author: {
                            id: firstDiscussionComment?.author?.id ?? "",
                            name: firstDiscussionComment?.author?.name ?? "",
                            username: firstDiscussionComment?.author?.username ?? ""
                        },
                        isResolved: isDiscussionResolved,
                        createdAt: firstDiscussionComment.created_at,
                        updatedAt: firstDiscussionComment.updated_at
                    }

                    return comment;
                })

            return validRequestReviews || null;

        } catch (error) {
            this.logger.error({
                message: `Error retrieving discussions for merge request: ${params.prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService getPullRequestDiscussions',
                error: error,
                metadata: params,
            });
            return null;
        }
    }

    async markReviewCommentAsResolved(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, commentId } = params;

            const projectId = repository.id;
            const mergeRequestIid = prNumber;
            const discussionId = commentId.toString();
            if (!projectId || !mergeRequestIid || !discussionId) {
                return null;
            }

            const gitlabAuthDetail = await this.getAuthDetails(organizationAndTeamData);

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const resolvedDiscussion = await gitlabAPI.MergeRequestDiscussions.resolve(
                projectId, mergeRequestIid, discussionId, true);

            return resolvedDiscussion || null;

        } catch (error) {
            this.logger.error({
                message: `Failed to mark discussion as resolved for merge request`,
                context: GitlabService.name,
                serviceName: 'GitlabService markReviewCommentAsResolved',
                error: error,
                metadata: {
                    projectId: params.repository.id,
                    mergeRequestIid: params.prNumber,
                    discussionId: params.commentId,
                    organizationAndTeamData: params.organizationAndTeamData
                },
            });
            throw new BadRequestException('Failed to mark discussion as resolved for merge request');

        }

    }
}
