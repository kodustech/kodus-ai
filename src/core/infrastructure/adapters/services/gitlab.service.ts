import {
    GitHubReaction,
    GitlabReaction,
} from '@/core/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import {
    PullRequest,
    PullRequestAuthor,
    PullRequestCodeReviewTime,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequestWithFiles,
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import {
    Repository,
    ReviewComment,
} from '@/config/types/general/codeReview.type';
import { Commit } from '@/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TreeItem } from '@/config/types/general/tree.type';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { GitlabAuthDetail } from '@/core/domain/authIntegrations/types/gitlab-auth-detail.type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { AuthMode } from '@/core/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { GitCloneParams } from '@/core/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
import { RepositoryFile } from '@/core/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import { CreateAuthIntegrationStatus } from '@/shared/domain/enums/create-auth-integration-status.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import {
    GitlabPullRequestState,
    PullRequestState,
} from '@/shared/domain/enums/pullRequestState.enum';
import { CacheService } from '@/shared/utils/cache/cache.service';
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
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@/shared/utils/translations/translations';
import {
    CommitSchema,
    Gitlab,
    MergeRequestSchema,
    MergeRequestSchemaWithBasicLabels,
    RepositoryTreeSchema,
} from '@gitbeaker/rest';
import { LLMModelProvider, LLMProviderService } from '@kodus/kodus-common/llm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as moment from 'moment-timezone';
import { v4 as uuidv4 } from 'uuid';
import { MCPManagerService } from '../mcp/services/mcp-manager.service';
import { PinoLoggerService } from './logger/pino.service';
import { PromptService } from './prompt.service';

@Injectable()
@IntegrationServiceDecorator(PlatformType.GITLAB, 'codeManagement')
export class GitlabService
    implements
        Omit<
            ICodeManagementService,
            | 'getOrganizations'
            | 'getPullRequestsWithChangesRequested'
            | 'getListOfValidReviews'
            | 'getPullRequestReviewThreads'
            | 'getAuthenticationOAuthToken'
            | 'getCommitsByReleaseMode'
            | 'getDataForCalculateDeployFrequency'
            | 'requestChangesPullRequest'
        >
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

        private readonly llmProviderService: LLMProviderService,

        private readonly promptService: PromptService,
        private readonly logger: PinoLoggerService,
        private readonly configService: ConfigService,
        private readonly cacheService: CacheService,
        private readonly mcpManagerService?: MCPManagerService,
    ) {}

    async getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        determineBots?: boolean;
    }): Promise<PullRequestAuthor[]> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return [];
            }

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
                return [];
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);
            const since = new Date();
            since.setDate(since.getDate() - 60);

            const authorsSet = new Set<string>();
            const authorsData = new Map<string, PullRequestAuthor>();

            // Busca paralela otimizada
            const repoPromises = repositories.map(async (repo) => {
                try {
                    const mergeRequests = await gitlabAPI.MergeRequests.all({
                        projectId: repo.id,
                        createdAfter: since.toISOString(),
                        perPage: 100,
                        orderBy: 'created_at',
                        sort: 'desc',
                    });

                    // Para na primeira contribuição de cada usuário
                    for (const mr of mergeRequests) {
                        if (mr.author?.id) {
                            const userId = mr.author.id.toString();

                            let type = 'user';
                            if (params.determineBots) {
                                const userInfo = await gitlabAPI.Users.show(
                                    mr.author.id,
                                );

                                type = userInfo?.bot ? 'bot' : 'user';
                            }

                            if (!authorsSet.has(userId)) {
                                authorsSet.add(userId);
                                authorsData.set(userId, {
                                    id: mr.author.id.toString(),
                                    name: mr.author.name || mr.author.username,
                                    type,
                                });
                            }
                        }
                    }
                } catch (error) {
                    this.logger.error({
                        message: 'Error in getPullRequestAuthors',
                        context: GitlabService.name,
                        error: error,
                        metadata: {
                            organizationAndTeamData:
                                params?.organizationAndTeamData,
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
                context: GitlabService.name,
                error: err,
                metadata: {
                    organizationAndTeamData: params?.organizationAndTeamData,
                },
            });
            return [];
        }
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
                        // Use source project ID so forked MRs can fetch files from the right project
                        id:
                            mergeRequest.source_project_id?.toString() ??
                            projectId,
                    },
                },
                base: {
                    ref: mergeRequest.target_branch,
                    repo: {
                        name: params.repository.name,
                        id: projectId,
                    },
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
            camelize: false,
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
                    startDate: moment().subtract(90, 'days').toDate(),
                    endDate: moment().toDate(),
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
                params.type,
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

            this.mcpManagerService?.createKodusMCPIntegration(
                params.organizationAndTeamData.organizationId,
            );

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
                            const buildRepository = async (
                                defaultBranch?: string,
                            ): Promise<Repositories> => {
                                return {
                                    id: project.id.toString(),
                                    name: project.path_with_namespace,
                                    http_url: project.http_url_to_repo,
                                    avatar_url: project.namespace?.avatar_url,
                                    organizationName: project.namespace?.name,
                                    visibility: (project?.visibility ===
                                    'public'
                                        ? 'public'
                                        : 'private') as 'public' | 'private',
                                    selected:
                                        integrationConfig?.configValue?.some(
                                            (repository: { name: string }) =>
                                                repository?.name ===
                                                project?.path_with_namespace,
                                        ),
                                    default_branch: defaultBranch,
                                    lastActivityAt: project.last_activity_at,
                                };
                            };

                            if (project?.default_branch) {
                                return buildRepository(project?.default_branch);
                            }

                            const projectDetails =
                                await gitlabAPI.Projects.show(project.id);

                            return buildRepository(
                                projectDetails?.default_branch,
                            );
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
                                    visibility: (project?.visibility ===
                                    'public'
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
                        }
                    }),
                );

                repositories.push(
                    ...batchResults.filter(
                        (repository) => repository !== undefined,
                    ),
                );

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

    /**
     * Retrieves merge requests from GitLab based on the provided parameters.
     * @param params - The parameters for fetching merge requests.
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
                    message:
                        'Organization ID is required to fetch pull requests.',
                    context: GitlabService.name,
                    metadata: params,
                });
                return [];
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const allRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !gitlabAuthDetail ||
                !allRepositories ||
                allRepositories.length === 0
            ) {
                this.logger.warn({
                    message: 'GitLab auth details or repositories not found.',
                    context: GitlabService.name,
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
                        context: GitlabService.name,
                        metadata: params,
                    });
                    return [];
                }
                reposToProcess = [foundRepo];
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const promises = reposToProcess.map(async (r) => {
                const mrs = await this.getMergeRequestsByRepo({
                    gitlabAPI,
                    repo: r,
                    filters,
                });

                return mrs.map((mr) =>
                    this.transformPullRequest(mr, r, organizationAndTeamData),
                );
            });

            const results = await Promise.all(promises);
            const mergeRequests = results.flat();

            return mergeRequests;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching merge requests from GitLab',
                context: GitlabService.name,
                error,
                metadata: params,
            });
            return [];
        }
    }

    /**
     * Retrieves merge requests from a specific GitLab repository.
     * @param params - The parameters for fetching, including the API instance, repository object, and filters.
     * @returns A promise that resolves to an array of raw merge request data, augmented with repository info.
     */
    private async getMergeRequestsByRepo(params: {
        gitlabAPI: InstanceType<typeof Gitlab<false>>; // false refers to camelize option
        repo: Repositories;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            state?: PullRequestState;
            author?: string;
            branch?: string;
        };
    }): Promise<MergeRequestSchema[]> {
        const { gitlabAPI, repo, filters = {} } = params;
        const { startDate, endDate, state, author, branch } = filters;

        const mergeRequests = await gitlabAPI.MergeRequests.all({
            projectId: repo.id,
            // @ts-ignore - value 'all' is valid according to GitLab API docs
            state: state
                ? this._prStateMapReverse.get(state)
                : this._prStateMapReverse.get(PullRequestState.ALL),
            sort: 'desc',
            orderBy: 'created_at',
            createdAfter: startDate?.toISOString(),
            createdBefore: endDate?.toISOString(),
            authorUsername: author,
            targetBranch: branch,
            perPage: 100,
        });

        return mergeRequests;
    }

    /**
     * Fetches all commits from Gitlab based on the provided parameters.
     * @param params - The parameters for fetching commits, including organization and team data, repository filters, and commit filters.
     * @param params.organizationAndTeamData - The organization and team data containing organizationId and teamId.
     * @param params.repository - Optional repository filter to fetch commits from a specific repository.
     * @param params.filters - Optional filters for commits, including startDate, endDate, author, and branch.
     * @param params.filters.startDate - The start date for filtering commits.
     * @param params.filters.endDate - The end date for filtering commits.
     * @param params.filters.author - The author of the commits to filter.
     * @param params.filters.branch - The branch from which to fetch commits.
     * @returns A promise that resolves to an array of Commit objects.
     */
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
            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const configuredRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !gitlabAuthDetail ||
                !configuredRepositories ||
                configuredRepositories.length === 0
            ) {
                this.logger.warn({
                    message: 'GitLab auth details or repositories not found.',
                    context: GitlabService.name,
                    metadata: params,
                });
                return [];
            }

            let reposToProcess: Repositories[] = configuredRepositories;

            if (repository && repository.name) {
                const foundRepo = configuredRepositories.find(
                    (r) => r.name === repository.name,
                );

                if (!foundRepo) {
                    this.logger.warn({
                        message: `Repository ${repository.name} not found in the list of configured repositories.`,
                        context: GitlabService.name,
                        metadata: params,
                    });
                    return [];
                }

                reposToProcess = [foundRepo];
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const promises = reposToProcess.map((repo) =>
                this.getCommitsByRepo({
                    gitlabAPI,
                    projectId: repo.id,
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
                message: 'Error fetching commits from GitLab',
                context: GitlabService.name,
                error,
                metadata: params,
            });
            return [];
        }
    }

    /**
     * Fetches all commits for a single GitLab repository based on the provided filters.
     * @param params - The parameters for fetching commits.
     * @returns A promise that resolves to an array of raw commit data.
     */
    private async getCommitsByRepo(params: {
        gitlabAPI: InstanceType<typeof Gitlab<false>>; // false refers to camelize option
        projectId: string | number;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            author?: string;
            branch?: string;
        };
    }): Promise<CommitSchema[]> {
        const { gitlabAPI, projectId, filters = {} } = params;
        const { startDate, endDate, author, branch } = filters;

        const commits = await gitlabAPI.Commits.all(projectId, {
            since: startDate?.toISOString(),
            until: endDate?.toISOString(),
            author: author, // doesn't seem to work
            refName: branch,
            perPage: 100,
            all: true,
        });

        const filteredCommits = commits.filter((commit) => {
            let isValid = true;

            if (author) {
                isValid =
                    isValid &&
                    (commit.author_name === author ||
                        commit.committer_name === author);
            }

            return isValid;
        });

        return filteredCommits.reverse();
    }

    async getListMembers(
        params: any,
    ): Promise<{ name: string; id: string | number; type?: string }[]> {
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
                let type = 'user';
                if (params.determineBots) {
                    const userInfo = await gitlabAPI.Users.show(user.id);

                    type = userInfo?.bot ? 'bot' : 'user';
                }

                uniqueUsersMap.set(user.id, {
                    ...user,
                    type,
                });
            }
        }

        const uniqueUsers = Array.from(uniqueUsersMap.values());

        return uniqueUsers.map((user) => {
            return {
                name: user.name,
                id: user.id,
                type: user.type,
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

        let llm = this.llmProviderService.getLLMProvider({
            model: LLMModelProvider.OPENAI_GPT_4O,
            temperature: 0,
            jsonMode: true,
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

        const chain = await llm.invoke(
            await promptWorkflows.format({
                organizationAndTeamData,
                payload: JSON.stringify(workflows),
                promptIsForChat: false,
            }),
            {
                metadata: {
                    module: 'Setup',
                    submodule: 'GetProductionDeployment',
                },
            },
        );

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

        let llm = this.llmProviderService.getLLMProvider({
            model: LLMModelProvider.OPENAI_GPT_4O,
            temperature: 0,
            jsonMode: true,
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

        const chain = await llm.invoke(
            await promptReleases.format({
                organizationAndTeamData,
                payload: JSON.stringify(releases),
                promptIsForChat: false,
            }),
            {
                metadata: {
                    module: 'Setup',
                    submodule: 'GetProductionReleases',
                },
            },
        );

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
            const perRepoLimit = Math.min(Math.max(filters?.limit || 5, 1), 10);
            const repoFilter = filters?.repositoryId
                ? new Set([String(filters.repositoryId)])
                : null;
            const useFastPath = Boolean(
                filters?.repositoryId || filters?.limit,
            );

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
                if (
                    repoFilter &&
                    !repoFilter.has(String(repo.id)) &&
                    !repoFilter.has(String(repo.name))
                ) {
                    continue;
                }

                let mergeRequests = await this.getMergeRequestFromRepository(
                    gitlabAPI,
                    repo.id,
                    startDate,
                    endDate,
                    prStatus,
                );

                if (useFastPath) {
                    mergeRequests = mergeRequests
                        .sort(
                            (a, b) =>
                                new Date(b.created_at).getTime() -
                                new Date(a.created_at).getTime(),
                        )
                        .slice(0, perRepoLimit);
                }

                const pullRequestDetails = await Promise.all(
                    mergeRequests.map(async (pullRequest) => {
                        const filesWithChanges = filters?.skipFiles
                            ? []
                            : await this.countChangesInMergeRequest(
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

    formatBodyForGitLab(
        lineComment: any,
        repository: any,
        translations: any,
        suggestionCopyPrompt: boolean,
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
            suggestionCopyPrompt = true,
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
                suggestionCopyPrompt,
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
        const {
            organizationAndTeamData,
            repository,
            prNumber,
            overallComment,
        } = params;

        const gitlabAuthDetail = await this.getAuthDetails(
            organizationAndTeamData,
        );

        const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

        try {
            const response = await gitlabAPI.MergeRequestNotes.create(
                repository.id,
                prNumber,
                overallComment,
            );
            return response;
        } catch (error) {
            console.error('Error creating comment in GitLab:', error);
            return null;
        }
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
            const filePath = params.file?.filename;
            if (!filePath) {
                return null;
            }

            const headRef = params?.pullRequest?.head?.ref;
            const baseRef = params?.pullRequest?.base?.ref;

            const headProjectId =
                params?.pullRequest?.head?.repo?.id ??
                params?.pullRequest?.head?.projectId ??
                params?.pullRequest?.head?.repoId ??
                params?.repository?.id;
            const baseProjectId =
                params?.pullRequest?.base?.repo?.id ??
                params?.pullRequest?.base?.projectId ??
                params?.pullRequest?.base?.repoId ??
                params?.repository?.id;

            const attempts: Array<{
                projectId: string;
                ref: string;
                source: string;
            }> = [];

            if (headRef && headProjectId) {
                attempts.push({
                    projectId: headProjectId,
                    ref: headRef,
                    source: 'head',
                });
            }

            if (baseRef && baseProjectId) {
                attempts.push({
                    projectId: baseProjectId,
                    ref: baseRef,
                    source: 'base',
                });
            }

            const tried = new Set<string>();
            for (const attempt of attempts) {
                const key = `${attempt.projectId}:${attempt.ref}`;
                if (tried.has(key)) continue;
                tried.add(key);

                try {
                    const fileContent = await gitlabAPI.RepositoryFiles.show(
                        attempt.projectId,
                        filePath,
                        attempt.ref,
                    );

                    return {
                        data: {
                            content: fileContent.content,
                            encoding: 'base64',
                        },
                    };
                } catch (attemptError: any) {
                    const status = attemptError?.response?.status;
                    const isNotFound = status === 404;

                    const logPayload = {
                        message: isNotFound
                            ? 'File not found in GitLab attempt'
                            : 'Error fetching file content from GitLab attempt',
                        context: GitlabService.name,
                        error: attemptError,
                        metadata: {
                            repository: params.repository,
                            file: filePath,
                            attempt,
                        },
                    };

                    if (isNotFound) {
                        this.logger.warn(logPayload);
                        continue; // Try next ref/project combo
                    }

                    this.logger.error(logPayload);
                }
            }

            // Final fallback: try default branch only if all prior attempts failed
            if (params.repository?.id) {
                try {
                    const defaultBranch = await this.getDefaultBranch({
                        organizationAndTeamData: params.organizationAndTeamData,
                        repository: {
                            id: params.repository?.id,
                            name: params.repository?.name,
                        },
                    });

                    if (defaultBranch) {
                        try {
                            const fileContent =
                                await gitlabAPI.RepositoryFiles.show(
                                    params.repository.id,
                                    filePath,
                                    defaultBranch,
                                );

                            return {
                                data: {
                                    content: fileContent.content,
                                    encoding: 'base64',
                                },
                            };
                        } catch (defaultAttemptError: any) {
                            const status =
                                defaultAttemptError?.response?.status;
                            const isNotFound = status === 404;

                            const logPayload = {
                                message: isNotFound
                                    ? 'File not found in GitLab default branch attempt'
                                    : 'Error fetching file content from GitLab default branch attempt',
                                context: GitlabService.name,
                                error: defaultAttemptError,
                                metadata: {
                                    repository: params.repository,
                                    file: filePath,
                                    attempt: {
                                        projectId: params.repository.id,
                                        ref: defaultBranch,
                                        source: 'default',
                                    },
                                },
                            };

                            if (isNotFound) {
                                this.logger.warn(logPayload);
                            } else {
                                this.logger.error(logPayload);
                            }
                        }
                    }
                } catch (defaultBranchError) {
                    this.logger.warn({
                        message:
                            'Could not resolve default branch while fetching file content',
                        context: GitlabService.name,
                        error: defaultBranchError,
                        metadata: {
                            repository: params.repository,
                            file: filePath,
                        },
                    });
                }
            }

            this.logger.warn({
                message:
                    'Exhausted all attempts to fetch file content from GitLab',
                context: GitlabService.name,
                metadata: {
                    repository: params.repository,
                    file: filePath,
                    attempts,
                },
            });
            return null;
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

        try {
            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const commits = await gitlabAPI.MergeRequests.allCommits(
                repository.id,
                prNumber,
            );

            this.logger.log({
                message: `Processing ${commits.length} commits for PR #${prNumber}`,
                context: GitlabService.name,
                serviceName:
                    'GitlabService getCommitsForPullRequestForCodeReview',
                metadata: {
                    prNumber,
                    repositoryId: repository.id,
                    commitsCount: commits.length,
                },
            });

            const commitDetails = await Promise.all(
                commits.map(async (commit) => {
                    const user = await this.getUserByEmailOrNameWithRetry({
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
                        parents:
                            commit?.parent_ids
                                ?.map((p) => ({ sha: p ?? '' }))
                                ?.filter((p) => p.sha) ?? [],
                    };
                }),
            );

            const sortedCommits = commitDetails.sort((a, b) => {
                return (
                    new Date(a?.created_at).getTime() -
                    new Date(b?.created_at).getTime()
                );
            });

            return sortedCommits;
        } catch (error) {
            this.logger.error({
                message: `Error fetching commits for PR #${prNumber}`,
                context: GitlabService.name,
                serviceName:
                    'GitlabService getCommitsForPullRequestForCodeReview',
                error: error,
                metadata: params,
            });
            throw error;
        }
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
            )?.notes[0];

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
                            originalCommit: {
                                body: originalCommit.body,
                                id: originalCommit.id,
                            },
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

    async addReactionToPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reaction: GitHubReaction | GitlabReaction;
    }): Promise<void> {
        try {
            if (!params.repository.id) {
                this.logger.warn({
                    message: 'Repository ID is required for GitLab reactions',
                    context: GitlabService.name,
                    metadata: params,
                });
                return;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            await gitlabAPI.MergeRequestAwardEmojis.award(
                params.repository.id,
                params.prNumber,
                params.reaction,
            );

            this.logger.log({
                message: `Added reaction ${params.reaction} to MR#${params.prNumber}`,
                context: GitlabService.name,
            });
        } catch (error) {
            this.logger.error({
                message: `Error adding reaction to MR#${params.prNumber}`,
                context: GitlabService.name,
                error: error,
                metadata: params,
            });
        }
    }

    async addReactionToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reaction: GitHubReaction | GitlabReaction;
    }): Promise<void> {
        try {
            if (!params.repository.id) {
                this.logger.warn({
                    message: 'Repository ID is required for GitLab reactions',
                    context: GitlabService.name,
                    metadata: params,
                });
                return;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            await gitlabAPI.MergeRequestNoteAwardEmojis.award(
                params.repository.id,
                params.prNumber,
                params.commentId,
                params.reaction,
            );

            this.logger.log({
                message: `Added reaction ${params.reaction} to note ${params.commentId} on MR#${params.prNumber}`,
                context: GitlabService.name,
            });
        } catch (error) {
            this.logger.error({
                message: `Error adding reaction to note ${params.commentId}`,
                context: GitlabService.name,
                error: error,
                metadata: params,
            });
        }
    }

    async removeReactionsFromPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reactions: (GitHubReaction | GitlabReaction)[];
    }): Promise<void> {
        try {
            if (!params.repository.id) {
                this.logger.warn({
                    message: 'Repository ID is required for GitLab reactions',
                    context: GitlabService.name,
                    metadata: params,
                });
                return;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const awards = await gitlabAPI.MergeRequestAwardEmojis.all(
                params.repository.id,
                params.prNumber,
            );

            const awardsToRemove = awards.filter((award: any) =>
                params.reactions.includes(award.name),
            );

            await Promise.all(
                awardsToRemove.map((award) =>
                    gitlabAPI.MergeRequestAwardEmojis.remove(
                        params.repository.id,
                        params.prNumber,
                        award.id,
                    ),
                ),
            );

            this.logger.log({
                message: `Removed reactions from MR#${params.prNumber}`,
                context: GitlabService.name,
                metadata: { awardsRemoved: awardsToRemove.length },
            });
        } catch (error) {
            this.logger.error({
                message: `Error removing reactions from MR#${params.prNumber}`,
                context: GitlabService.name,
                error: error,
                metadata: params,
            });
        }
    }

    async removeReactionsFromComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reactions: (GitHubReaction | GitlabReaction)[];
    }): Promise<void> {
        try {
            if (!params.repository.id) {
                this.logger.warn({
                    message: 'Repository ID is required for GitLab reactions',
                    context: GitlabService.name,
                    metadata: params,
                });
                return;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const awards = await gitlabAPI.MergeRequestNoteAwardEmojis.all(
                params.repository.id,
                params.prNumber,
                params.commentId,
            );

            const awardsToRemove = awards.filter((award: any) =>
                params.reactions.includes(award.name),
            );

            await Promise.all(
                awardsToRemove.map((award) =>
                    gitlabAPI.MergeRequestNoteAwardEmojis.remove(
                        params.repository.id,
                        params.prNumber,
                        params.commentId,
                        award.id,
                    ),
                ),
            );

            this.logger.log({
                message: `Removed reactions from note ${params.commentId} on MR#${params.prNumber}`,
                context: GitlabService.name,
                metadata: { awardsRemoved: awardsToRemove.length },
            });
        } catch (error) {
            this.logger.error({
                message: `Error removing reactions from note ${params.commentId}`,
                context: GitlabService.name,
                error: error,
                metadata: params,
            });
        }
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

    async getCloneParams(params: {
        repository: Pick<
            Repository,
            'id' | 'defaultBranch' | 'fullName' | 'name'
        >;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<GitCloneParams> {
        try {
            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                throw new Error('GitLab authentication details not found');
            }

            // Construct the full GitLab URL
            const gitlabHost = gitlabAuthDetail.host || 'gitlab.com';
            const fullGitlabUrl = `https://${gitlabHost}/${params?.repository?.fullName}`;

            return {
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
            };
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
                    context: GitlabService.name,
                    serviceName: 'GitlabService getReviewStatusByPullRequest',
                    metadata: {
                        repository: params.repository,
                        prNumber: params.prNumber,
                    },
                });
                return null;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const [approvalSettings, currentUser] = await Promise.all([
                gitlabAPI.MergeRequestApprovals.showConfiguration(
                    repository.id,
                    { mergerequestIId: prNumber },
                ),
                gitlabAPI.Users.showCurrentUser(),
            ]);

            const approvedByUsers = approvalSettings?.approved_by ?? [];

            const isApprovedByCurrentUser = approvedByUsers.some(
                (approval) => approval?.user?.id === currentUser.id,
            );

            return isApprovedByCurrentUser
                ? PullRequestReviewState.APPROVED
                : null;
        } catch (error) {
            this.logger.error({
                message: `Error fetching review status for MR #${params.prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService getReviewStatusByPullRequest',
                error: error,
                metadata: {
                    repository: params.repository,
                    prNumber: params.prNumber,
                },
            });
            return null;
        }
    }

    async checkIfPullRequestShouldBeApproved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const reviewStatus = await this.getReviewStatusByPullRequest({
                organizationAndTeamData,
                repository,
                prNumber,
            });

            if (reviewStatus === PullRequestReviewState.APPROVED) {
                return null;
            }

            await this.approvePullRequest({
                organizationAndTeamData,
                prNumber,
                repository,
            });

            this.logger.log({
                message: `Approved pull request #${prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService approvePullRequest',
                metadata: params,
            });
        } catch (error) {
            this.logger.error({
                message: `Error to approve pull request #${params.prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService checkIfPullRequestShouldBeApproved',
                error: error,
                metadata: params,
            });
            return null;
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

    private async getUserByEmailOrNameWithRetry(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            email?: string;
            userName: string;
        },
        maxRetries: number = 3,
        timeout: number = 5000,
    ): Promise<any | null> {
        const { userName, email } = params;

        // Chave de cache única para este usuário
        const cacheKey = `gitlab-user-${email || 'no-email'}-${userName}`;

        try {
            const cachedUser = await this.cacheService.getFromCache(cacheKey);
            if (cachedUser) {
                return cachedUser;
            }
        } catch (cacheError) {
            this.logger.warn({
                message: 'Error reading from cache, continuing with API call',
                context: GitlabService.name,
                serviceName: 'GitlabService getUserByEmailOrNameWithRetry',
                error: cacheError,
            });
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(
                        () => reject(new Error('Request timeout')),
                        timeout,
                    );
                });

                const userPromise = this.getUserByEmailOrName({
                    organizationAndTeamData: params.organizationAndTeamData,
                    email: params.email || '',
                    userName: params.userName,
                });

                const user = await Promise.race([userPromise, timeoutPromise]);

                if (user) {
                    try {
                        await this.cacheService.addToCache(
                            cacheKey,
                            user,
                            1800000,
                        ); // 30 minutos
                    } catch (cacheError) {
                        this.logger.warn({
                            message: 'Error saving to cache',
                            context: GitlabService.name,
                            serviceName:
                                'GitlabService getUserByEmailOrNameWithRetry',
                            error: cacheError,
                        });
                    }
                }

                return user;
            } catch (error) {
                this.logger.warn({
                    message: `Attempt ${attempt}/${maxRetries} failed for user: ${email || userName}`,
                    context: GitlabService.name,
                    serviceName: 'GitlabService getUserByEmailOrNameWithRetry',
                    error: error,
                    metadata: { attempt, maxRetries, email, userName },
                });

                if (attempt === maxRetries) {
                    this.logger.error({
                        message: `All ${maxRetries} attempts failed for user: ${email || userName}, returning null to continue flow`,
                        context: GitlabService.name,
                        serviceName:
                            'GitlabService getUserByEmailOrNameWithRetry',
                        error: error,
                        metadata: params,
                    });
                    return null;
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, Math.pow(2, attempt) * 1000),
                );
            }
        }

        return null;
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

    async getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null> {
        try {
            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);
            const user = await gitlabAPI.Users.showCurrentUser();

            return user || null;
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving current GitLab user',
                context: GitlabService.name,
                serviceName: 'GitlabService getCurrentUser',
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
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const projectId = repository.id;
            const mergeRequestIid = prNumber;

            if (!projectId || !mergeRequestIid) {
                return null;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const discussions = await gitlabAPI.MergeRequestDiscussions.all(
                projectId,
                mergeRequestIid,
            );

            const validRequestReviews = discussions
                .filter((discussion) => {
                    const firstDiscussionComment = discussion.notes[0];
                    return (
                        firstDiscussionComment.resolvable &&
                        !hasKodyMarker(firstDiscussionComment.body)
                    );
                })
                .map((discussion) => {
                    // The review comment will always be the first one.
                    const firstDiscussionComment = discussion.notes[0];
                    const isDiscussionResolved: boolean =
                        firstDiscussionComment.resolved &&
                        firstDiscussionComment.resolved === true
                            ? true
                            : false;

                    const comment: PullRequestReviewComment = {
                        id: firstDiscussionComment.id,
                        threadId: discussion.id,
                        body: firstDiscussionComment.body ?? '',
                        author: {
                            id: firstDiscussionComment?.author?.id ?? '',
                            name: firstDiscussionComment?.author?.name ?? '',
                            username:
                                firstDiscussionComment?.author?.username ?? '',
                        },
                        isResolved: isDiscussionResolved,
                        createdAt: firstDiscussionComment.created_at,
                        updatedAt: firstDiscussionComment.updated_at,
                    };

                    return comment;
                });

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
            const { organizationAndTeamData, repository, prNumber, commentId } =
                params;

            const projectId = repository.id;
            const mergeRequestIid = prNumber;
            const discussionId = commentId.toString();
            if (!projectId || !mergeRequestIid || !discussionId) {
                return null;
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const resolvedDiscussion =
                await gitlabAPI.MergeRequestDiscussions.resolve(
                    projectId,
                    mergeRequestIid,
                    discussionId,
                    true,
                );

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
                    organizationAndTeamData: params.organizationAndTeamData,
                },
            });
            throw new BadRequestException(
                'Failed to mark discussion as resolved for merge request',
            );
        }
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

            const gitlabAPI = this.instanceGitlabApi(authDetails);

            const webhookUrl =
                this.configService.get<string>(
                    'API_GITLAB_CODE_MANAGEMENT_WEBHOOK',
                ) ?? process.env.API_GITLAB_CODE_MANAGEMENT_WEBHOOK;

            if (!webhookUrl) {
                return false;
            }

            const normalizedProjectId =
                typeof repositoryId === 'string' && /^\d+$/.test(repositoryId)
                    ? Number(repositoryId)
                    : repositoryId;

            const hooks = await gitlabAPI.ProjectHooks.all(normalizedProjectId);

            return hooks.some((hook) => hook?.url === webhookUrl);
        } catch (error) {
            this.logger.error({
                message: 'Error verifying GitLab webhook status',
                context: GitlabService.name,
                serviceName: 'GitlabService isWebhookActive',
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

        const gitlabAPI = this.instanceGitlabApi(authDetails);

        const integration = await this.integrationService.findOne({
            organization: {
                uuid: params.organizationAndTeamData.organizationId,
            },
            team: { uuid: params.organizationAndTeamData.teamId },
            platform: PlatformType.GITLAB,
        });

        if (!integration?.authIntegration?.authDetails) {
            return;
        }

        const repositories =
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                params.organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

        if (repositories) {
            for (const repo of repositories) {
                try {
                    const webhooks = await gitlabAPI.ProjectHooks.all(repo.id);
                    const webhookUrl = this.configService.get<string>(
                        'API_GITLAB_CODE_MANAGEMENT_WEBHOOK',
                    );

                    const webhookToDelete = webhooks.find(
                        (webhook) => webhook.url === webhookUrl,
                    );

                    if (webhookToDelete) {
                        await gitlabAPI.ProjectHooks.remove(
                            repo.id,
                            webhookToDelete.id,
                        );
                    }
                } catch (error) {
                    this.logger.error({
                        message: `Error deleting webhook for repository ${repo.name}`,
                        context: GitlabService.name,
                        error: error,
                        metadata: {
                            organizationAndTeamData:
                                params.organizationAndTeamData,
                            repoId: repo.id,
                        },
                    });
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

        // HEADER - Badges (formato similar ao GitHub)
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
            commentBody += this.formatSub(translations.feedback);
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
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return null;
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const mergeRequest = await gitlabAPI.MergeRequests.show(
                repository.id,
                prNumber,
            );

            if (!mergeRequest) {
                return null;
            }

            return this.transformPullRequest(
                mergeRequest,
                repository,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: `Error retrieving pull request details for #${params.prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService getPullRequestDetails',
                error: error,
                metadata: params,
            });
            return null;
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

            if (!repository?.id) {
                this.logger.warn({
                    message: 'Repository ID is required to get all files',
                    context: GitlabService.name,
                    serviceName: 'GitlabService getRepositoryAllFiles',
                    metadata: params,
                });

                return [];
            }

            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                this.logger.warn({
                    message: 'GitLab authentication details not found',
                    context: GitlabService.name,
                    serviceName: 'GitlabService getRepositoryAllFiles',
                    metadata: params,
                });

                return [];
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

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
                        message: 'Default branch not found for repository',
                        context: GitlabService.name,
                        serviceName: 'GitlabService getRepositoryAllFiles',
                        metadata: params,
                    });

                    return [];
                }
            }

            // Extract base directories from filePatterns
            const baseDirectoriesRaw = this.extractBaseDirectoriesFromPatterns(
                filePatterns || [],
            );
            const globChars = ['*', '?', '{', '}', '[', ']', '!'];
            const hasRootOnlyPatterns = (filePatterns || []).some((pattern) => {
                const normalized = pattern
                    .replace(/^\/+/, '')
                    .replace(/\\/g, '/');
                const hasGlob = globChars.some((ch) => normalized.includes(ch));
                const hasSlash = normalized.includes('/');
                // Plain filename (no glob, no directory) -> needs root scan
                return !hasGlob && !hasSlash;
            });
            // Include root as a base directory if patterns target files at repo root
            const baseDirectories = hasRootOnlyPatterns
                ? [''].concat(baseDirectoriesRaw.filter((dir) => dir !== ''))
                : baseDirectoriesRaw;

            let allFiles: RepositoryFile[] = [];

            // If we have specific directories, search only them
            if (baseDirectories.length > 0) {
                // Search files from each specific directory
                for (const baseDir of baseDirectories) {
                    try {
                        const options: any = {
                            ref: branch,
                            recursive: true, // deep search for subdirs
                        };

                        // For root scans (''), avoid recursion to keep it fast and match only top-level files
                        if (!baseDir) {
                            options.recursive = false;
                        } else {
                            options.path = baseDir;
                        }

                        const trees =
                            await gitlabAPI.Repositories.allRepositoryTrees(
                                repository.id,
                                options,
                            );

                        const files = trees
                            .filter((file) => file.type === 'blob')
                            .map((file) => this.transformRepositoryFile(file));

                        allFiles.push(...files);
                    } catch (dirError) {
                        this.logger.warn({
                            message: `Error fetching directory ${baseDir}`,
                            context: GitlabService.name,
                            error: dirError,
                            metadata: { baseDir, repository: repository.name },
                        });
                        // Continue to the next directory
                    }
                }
            } else {
                // Fallback: if there are no specific patterns, search everything (original behavior)
                const trees = await gitlabAPI.Repositories.allRepositoryTrees(
                    repository.id,
                    {
                        ref: branch,
                        recursive: true,
                    },
                );

                allFiles = trees
                    .filter((file) => file.type === 'blob')
                    .map((file) => this.transformRepositoryFile(file));
            }

            // Filter files by patterns (if any pattern does not have a clear base directory)
            const filteredFiles: RepositoryFile[] = [];
            for (const file of allFiles) {
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
                message: `Retrieved ${filteredFiles.length} files from repository`,
                context: GitlabService.name,
                serviceName: 'GitlabService getRepositoryAllFiles',
                metadata: {
                    ...params,
                    retrievedFilesCount: filteredFiles.length,
                    baseDirectoriesSearched: baseDirectories,
                },
            });

            return filteredFiles;
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving all files from repository',
                context: GitlabService.name,
                serviceName: 'GitlabService getRepositoryAllFiles',
                error: error.message,
                metadata: params,
            });

            return [];
        }
    }

    private extractBaseDirectoriesFromPatterns(patterns: string[]): string[] {
        const globChars = ['*', '?', '{', '}', '[', ']', '!'];
        const baseDirs = new Set<string>();

        for (const pattern of patterns) {
            const normalized = pattern.replace(/^\/+/, '').replace(/\\/g, '/');

            if (!globChars.some((char) => normalized.includes(char))) {
                const lastSlash = normalized.lastIndexOf('/');
                if (lastSlash > 0) {
                    baseDirs.add(normalized.substring(0, lastSlash));
                }
                continue;
            }

            const parts = normalized.split('/');
            const basePathParts: string[] = [];

            for (const part of parts) {
                if (globChars.some((char) => part.includes(char))) {
                    break;
                }
                basePathParts.push(part);
            }

            if (basePathParts.length > 0) {
                const basePath = basePathParts.join('/');
                baseDirs.add(basePath.replace(/\/+$/, ''));
            }
        }

        return Array.from(baseDirs)
            .filter((dir) => dir.length > 0)
            .sort();
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
            const gitlabAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                throw new Error('GitLab authentication details not found');
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            return gitlabAPI.MergeRequestDiscussions.editNote(
                repository.id,
                prNumber,
                parentId,
                Number(commentId),
                { body },
            );
        } catch (error) {
            this.logger.error({
                message: `Error updating response to comment ${commentId} in PR #${prNumber}`,
                context: GitlabService.name,
                serviceName: 'GitlabService updateResponseToComment',
                error: error,
                metadata: params,
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
                message: `Error checking if PR #${params.prNumber} is a draft`,
                context: GitlabService.name,
                serviceName: 'GitlabService isDraftPullRequest',
                error: error,
                metadata: params,
            });
            return false;
        }
    }

    //#region Transformers

    /**
     * Transforms a raw commit object from the GitLab API into the standard Commit interface.
     * @param rawCommit - The raw commit data from the GitLab API.
     * @returns A Commit object.
     */
    private transformCommit(rawCommit: CommitSchema): Commit {
        return {
            sha: rawCommit.id ?? '',
            commit: {
                author: {
                    id: '', // The author object in a GitLab commit doesn't have a user ID.
                    name:
                        rawCommit.author_name ?? rawCommit.committer_name ?? '',
                    email:
                        rawCommit.author_email ??
                        rawCommit.committer_email ??
                        '',
                    date:
                        rawCommit.created_at ??
                        rawCommit.authored_date ??
                        rawCommit.committed_date ??
                        '',
                },
                message: rawCommit.message ?? '',
            },
            parents:
                rawCommit.parent_ids
                    ?.map((parentId) => ({
                        sha: parentId ?? '',
                    }))
                    .filter((parent) => parent.sha) ?? [],
        };
    }

    private readonly _prStateMap = new Map<
        GitlabPullRequestState,
        PullRequestState
    >([
        [GitlabPullRequestState.OPENED, PullRequestState.OPENED],
        [GitlabPullRequestState.MERGED, PullRequestState.MERGED],
        [GitlabPullRequestState.CLOSED, PullRequestState.CLOSED],
        [GitlabPullRequestState.LOCKED, PullRequestState.CLOSED],
    ]);

    private readonly _prStateMapReverse = new Map<
        PullRequestState,
        GitlabPullRequestState | string
    >([
        [PullRequestState.OPENED, GitlabPullRequestState.OPENED],
        [PullRequestState.MERGED, GitlabPullRequestState.MERGED],
        [PullRequestState.CLOSED, GitlabPullRequestState.CLOSED],
        [PullRequestState.ALL, 'all'],
    ]);

    /**
     * Transforms a raw merge request object from the Gitlab API into the standard PullRequest interface.
     * @param mergeRequest - The raw merge request data from the Gitlab API.
     * @param organizationAndTeamData - The organization and team context.
     * @returns A PullRequest object.
     */
    private transformPullRequest(
        mergeRequest: MergeRequestSchema,
        repository: Partial<Repositories>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): PullRequest {
        return {
            id: mergeRequest?.id?.toString() ?? '',
            number: mergeRequest?.iid ?? -1,
            pull_number: mergeRequest?.iid ?? -1, // TODO: remove, legacy, use number
            organizationId: organizationAndTeamData?.organizationId ?? '',
            title: mergeRequest?.title ?? '',
            body: mergeRequest?.description ?? '',
            state:
                this._prStateMap.get(
                    mergeRequest?.state as GitlabPullRequestState,
                ) ?? PullRequestState.ALL,
            prURL: mergeRequest?.web_url ?? '',
            repository: repository?.name ?? '', // TODO: remove, legacy, use repositoryData
            repositoryId: repository?.id ?? '', // TODO: remove, legacy, use repositoryData
            repositoryData: {
                id: repository?.id ?? '',
                name: repository?.name ?? '',
            },
            message: mergeRequest?.title ?? '',
            created_at: mergeRequest?.created_at ?? '',
            closed_at: mergeRequest?.closed_at ?? '',
            updated_at: mergeRequest?.updated_at ?? '',
            merged_at: mergeRequest?.merged_at ?? '',
            participants: [
                {
                    id: mergeRequest?.author?.id?.toString() ?? '',
                },
            ],
            reviewers:
                mergeRequest?.reviewers?.map((r) => ({
                    id: r?.id?.toString() ?? '',
                })) ?? [],
            sourceRefName: mergeRequest?.source_branch ?? '', // TODO: remove, legacy, use head.ref
            head: {
                ref: mergeRequest?.source_branch ?? '',
                repo: {
                    id: mergeRequest?.source_project_id?.toString() ?? '',
                    name: '',
                    defaultBranch: '',
                    fullName: '',
                },
            },
            targetRefName: mergeRequest?.target_branch ?? '', // TODO: remove, legacy, use base.ref
            base: {
                ref: mergeRequest?.target_branch ?? '',
                repo: {
                    id: repository?.id ?? '',
                    name: repository?.name ?? '',
                    defaultBranch: repository?.default_branch ?? '',
                    fullName: repository?.name ?? '',
                },
            },
            user: {
                login: mergeRequest?.author?.username ?? '',
                name: mergeRequest?.author?.name ?? '',
                id: mergeRequest?.author?.id?.toString() ?? '',
            },
            isDraft: mergeRequest?.draft ?? false,
        };
    }

    private transformRepositoryFile(
        file: RepositoryTreeSchema,
    ): RepositoryFile {
        return {
            filename: file?.path?.split('/').pop() ?? '',
            sha: file?.id ?? '',
            size: -1, // GitLab does not provide file size in the tree entry
            path: file?.path ?? '',
            type: file?.type ?? 'blob',
        };
    }

    async getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<any[]> {
        try {
            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return [];
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            const tree = await gitlabAPI.Repositories.allRepositoryTrees(
                params.repositoryId,
                {
                    recursive: true,
                },
            );

            return tree.map((item: any) => ({
                path: item.path,
                type: item.type === 'tree' ? 'directory' : 'file',
                id: item.id,
                mode: item.mode,
                name: item.name,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree from GitLab',
                context: GitlabService.name,
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
            const gitlabAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!gitlabAuthDetail) {
                return [];
            }

            const gitlabAPI = this.instanceGitlabApi(gitlabAuthDetail);

            // Configurar opções da busca
            const options: any = {
                recursive: false, // ← IMPORTANTE: apenas 1 nível
            };

            // Se tem directoryPath, adicionar nas opções
            if (params.directoryPath) {
                options.path = params.directoryPath;
            }

            // Buscar a árvore do diretório
            const tree = await gitlabAPI.Repositories.allRepositoryTrees(
                params.repositoryId,
                options,
            );

            // Filtrar apenas diretórios e mapear para o formato padrão
            const directories = tree
                .filter((item: any) => item.type === 'tree')
                .map((item: any) => {
                    const fullPath = params.directoryPath
                        ? `${params.directoryPath}/${item.name}`
                        : item.name;

                    return {
                        path: fullPath,
                        type: 'directory' as const,
                        sha: item.id,
                        size: undefined,
                        url: undefined,
                        hasChildren: true,
                    };
                });

            return directories;
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting repository tree by directory from GitLab',
                context: GitlabService.name,
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
}
