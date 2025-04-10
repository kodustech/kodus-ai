import { IGithubService } from '@/core/domain/github/contracts/github.service.contract';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { v4 as uuidv4 } from 'uuid';
import { extractRepoData, extractRepoNames } from '@/shared/utils/helpers';
import { createAppAuth } from '@octokit/auth-app';
import { InstallationStatus } from '@/shared/domain/enums/github-installation-status.enum';
import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import {
    INTEGRATION_SERVICE_TOKEN,
    IIntegrationService,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import { GithubAuthDetail } from '@/core/domain/authIntegrations/types/github-auth-detail.type';
import {
    OneSentenceSummaryItem,
    PullRequestCodeReviewTime,
    PullRequestDetails,
    PullRequestFile,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequests,
    PullRequestsWithChangesRequested,
    PullRequestWithFiles,
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import * as moment from 'moment-timezone';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { PromptService } from '../prompt.service';
import { PinoLoggerService } from '../logger/pino.service';
import { DeployFrequency } from '@/core/domain/platformIntegrations/types/codeManagement/deployFrequency.type';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import { CommitLeadTimeForChange } from '@/core/domain/platformIntegrations/types/codeManagement/commitLeadTimeForChange.type';
import { Commit } from '@/config/types/general/commit.type';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import { decrypt, encrypt } from '@/shared/utils/crypto';
import { AuthMode } from '@/core/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { CodeManagementConnectionStatus } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import {
    DORA_METRICS_FACTORY_TOKEN,
    IDoraMetricsFactory,
} from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import {
    ORGANIZATION_METRICS_SERVICE_TOKEN,
    IOrganizationMetricsService,
} from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';
import { CacheService } from '@/shared/utils/cache/cache.service';
import { GitHubReaction } from '@/core/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@/shared/utils/translations/translations';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import { getLabelShield } from '@/shared/utils/codeManagement/labels';
import {
    IRepositoryManager,
    REPOSITORY_MANAGER_TOKEN,
} from '@/core/domain/repository/contracts/repository-manager.contract';
import { CommentResult, Repository } from '@/config/types/general/codeReview.type';
import { CreateAuthIntegrationStatus } from '@/shared/domain/enums/create-auth-integration-status.enum';
import { ReviewComment } from '@/config/types/general/codeReview.type';
import { getSeverityLevelShield } from '@/shared/utils/codeManagement/severityLevel';
import { getCodeReviewBadge } from '@/shared/utils/codeManagement/codeReviewBadge';
import { IRepository } from '@/core/domain/pullRequests/interfaces/pullRequests.interface';

interface GitHubAuthResponse {
    token: string;
    expiresAt: string;
    permissions?: Record<string, string>;
    repositorySelection?: string;
}

@Injectable()
@IntegrationServiceDecorator(PlatformType.GITHUB, 'codeManagement')
export class GithubService
    implements IGithubService, Omit<ICodeManagementService, 'getOrganizations'> {
    private readonly MAX_RETRY_ATTEMPTS = 2;
    private readonly TTL = 50 * 60 * 1000; // 50 minutes

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(ORGANIZATION_METRICS_SERVICE_TOKEN)
        private readonly organizationMetricsService: IOrganizationMetricsService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parameterService: IParametersService,

        @Inject(DORA_METRICS_FACTORY_TOKEN)
        private readonly doraMetricsFactory: IDoraMetricsFactory,

        @Inject(REPOSITORY_MANAGER_TOKEN)
        private readonly repositoryManager: IRepositoryManager,

        private readonly cacheService: CacheService,

        private readonly promptService: PromptService,
        private readonly logger: PinoLoggerService,
    ) { }


    getUserById(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        userId: string;
    }): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    getLanguageRepository(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    createSingleIssueComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
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

    // Helper functions
    private createOctokitInstance(): Octokit {
        return new Octokit({
            authStrategy: createAppAuth,
            auth: {
                appId: process.env.API_GITHUB_APP_ID,
                privateKey: process.env.API_GITHUB_PRIVATE_KEY.replace(
                    /\\n/g,
                    '\n',
                ),
                clientId: process.env.GLOBAL_GITHUB_CLIENT_ID,
                clientSecret: process.env.API_GITHUB_CLIENT_SECRET,
            },
        });
    }

    async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.GITHUB,
            });

            if (!integration) {
                return;
            }

            const team = await this.teamService.findOne({
                uuid: params.organizationAndTeamData.teamId,
            });

            await this.integrationConfigService.createOrUpdateConfig(
                params.configKey,
                params.configValue,
                integration?.uuid,
                params.organizationAndTeamData,
            );

            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );

            if (githubAuthDetail?.authMode === AuthMode.TOKEN) {
                await this.createPullRequestWebhook({
                    organizationAndTeamData: params.organizationAndTeamData,
                });
            }
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

    async authenticateWithCodeOauth(
        params: any,
    ): Promise<{ success: boolean; status?: CreateAuthIntegrationStatus }> {
        try {
            const appOctokit = this.createOctokitInstance();

            const installationAuthentication = await appOctokit.auth({
                type: 'installation',
                installationId: params.code,
            });

            const installLogin = await appOctokit.rest.apps.getInstallation({
                installation_id: parseInt(params.code),
            });

            const isUserToken =
                installLogin?.data?.target_type?.toLowerCase() === 'user';
            if (isUserToken)
                return {
                    success: false,
                    status: CreateAuthIntegrationStatus.NO_ORGANIZATION,
                };

            const authDetails = {
                // @ts-ignore
                authToken: installationAuthentication?.token,
                installationId:
                    // @ts-ignore
                    installationAuthentication?.installationId || null,
                // @ts-ignore
                org: installLogin?.data.account?.login || null,
                authMode: params.authMode || AuthMode.OAUTH,
            };

            const repoPermissions = await this.checkRepositoryPermissions({
                organizationAndTeamData: params.organizationAndTeamData,
                // @ts-ignore
                org: installLogin?.data.account?.login,
                authDetails,
            });

            if (!repoPermissions.success) return repoPermissions;

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.GITHUB,
            });

            await this.handleIntegration(
                integration,
                authDetails,
                params.organizationAndTeamData,
            );

            const githubStatus = await this.findOneByOrganizationId(
                params.organizationAndTeamData,
            );
            if (
                githubStatus?.installationStatus === InstallationStatus.PENDING
            ) {
                await this.updateInstallationItems(
                    { installationStatus: InstallationStatus.SUCCESS },
                    params.organizationAndTeamData,
                );
            }

            return {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
        } catch (err) {
            throw new BadRequestException(
                err.message || 'Error authenticating with OAUTH.',
            );
        }
    }

    async authenticateWithToken(
        params: any,
    ): Promise<{ success: boolean; status?: CreateAuthIntegrationStatus }> {
        try {
            const { token } = params;
            const userOctokit = new Octokit({ auth: token });

            // Verificar se o PAT setá associado à organização especificada
            const orgs = await userOctokit.rest.orgs.listForAuthenticatedUser();

            if (!orgs?.data[0]?.login) {
                return {
                    success: false,
                    status: CreateAuthIntegrationStatus.NO_ORGANIZATION,
                };
            }

            const orgLogin = orgs.data[0].login;

            const encryptedPAT = encrypt(token);

            const authDetails = {
                authToken: encryptedPAT,
                org: orgLogin,
                authMode: params.authMode || AuthMode.TOKEN,
            };

            const repoPermissions = await this.checkRepositoryPermissions({
                organizationAndTeamData: params.organizationAndTeamData,
                org: orgLogin,
                authDetails,
            });

            if (!repoPermissions.success) return repoPermissions;

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.GITHUB,
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
                'Error authenticating with GITHUB PAT.',
            );
        }
    }

    private async checkRepositoryPermissions(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        org: string;
        authDetails: GithubAuthDetail;
    }) {
        try {
            const { organizationAndTeamData, org, authDetails } = params;

            const octokit = await this.instanceOctokit(
                organizationAndTeamData,
                authDetails,
            );

            const repos = await octokit.paginate(
                octokit.rest.repos.listForOrg,
                { org },
            );

            if (repos.length === 0) {
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
                context: GithubService.name,
                error: error,
                metadata: params,
            });
            return {
                success: false,
                status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
            };
        }
    }

    private async filterMembers(
        organizationAndTeamData: OrganizationAndTeamData,
        membersToFilter: string[],
    ) {
        const members = await this.getListMembers({ organizationAndTeamData });

        return members?.filter((member) => {
            const normalizedMemberName = member.name.toLowerCase();

            return membersToFilter?.some((filter) => {
                const normalizedFilter = filter.toLowerCase();
                return (
                    normalizedMemberName.includes(normalizedFilter) ||
                    normalizedFilter.includes(normalizedMemberName)
                );
            });
        });
    }

    async getListMembers(
        params: any,
    ): Promise<{ name: string; id: string | number }[]> {
        const members = await this.getAllMembersByOrg(
            params.organizationAndTeamData,
        );

        return members?.map((user) => {
            return {
                name: user.login,
                id: user.id,
            };
        });
    }

    async getCommits(params: any): Promise<Commit[]> {
        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!githubAuthDetail || !repositories) {
                return null;
            }

            const formatRepo = extractRepoNames(repositories);

            const octokit = await this.instanceOctokit(
                params.organizationAndTeamData,
            );

            const { startDate, endDate } = params.filters || {};

            const promises = formatRepo.map(async (repo) => {
                return await this.getAllCommits(
                    octokit,
                    githubAuthDetail?.org,
                    repo,
                    startDate,
                    endDate,
                );
            });

            const results = await Promise.all(promises);

            const commits =
                results?.flat()?.map((item) => ({
                    sha: item?.sha,
                    commit: {
                        author: {
                            id: item?.commit?.author?.id,
                            name: item?.commit?.author?.name,
                            email: item?.commit?.author?.email,
                            date: item?.commit?.author?.date,
                        },
                        message: item?.commit?.message,
                    },
                })) || null;

            return commits;
        } catch (err) {
            return [];
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
    /**
     * Retrieves the authentication details for a specific GitHub Oauth organization.
     *
     * @param {string} organizationId - The ID of the GitHub organization.
     * @return {Promise<GithubAuthDetail>} - The authentication details for the GitHub organization.
     */
    async getGithubAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<GithubAuthDetail> {
        const githubAuthDetail =
            await this.integrationService.getPlatformAuthDetails<GithubAuthDetail>(
                organizationAndTeamData,
                PlatformType.GITHUB,
            );

        return {
            ...githubAuthDetail,
            authMode: githubAuthDetail?.authMode || AuthMode.OAUTH,
        };
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
            if (!params?.organizationAndTeamData.organizationId) return null;

            const filters = params?.filters ?? {};

            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );
            const allRepositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params?.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!githubAuthDetail || !allRepositories) {
                return null;
            }

            const octokit = await this.instanceOctokit(
                params?.organizationAndTeamData,
            );
            const { startDate, endDate, includeChanges, pullRequestNumbers } =
                filters || {};

            const assigneeFilter = filters.assignFilter;
            let filteredMembers;

            if (assigneeFilter) {
                filteredMembers = await this.filterMembers(
                    params?.organizationAndTeamData,
                    assigneeFilter,
                );
            }

            let pullRequests = [];

            if (pullRequestNumbers && pullRequestNumbers?.length > 0) {
                for (const repo of allRepositories) {
                    for (const number of pullRequestNumbers) {
                        try {
                            const prResponse = await octokit.rest.pulls.get({
                                owner: githubAuthDetail?.org,
                                repo: repo.name,
                                pull_number: number,
                            });

                            const pr = prResponse.data;

                            if (pr) {
                                const pullRequestData: any = {
                                    id: pr.id,
                                    repository: repo.name,
                                    repositoryId: repo.id,
                                    pull_number: pr.number,
                                    author_id: pr.user.id,
                                    author_name: pr.user.login,
                                    author_created_at: pr.created_at,
                                    message: pr.title,
                                    state: pr.state,
                                };

                                // Apply additional filters if necessary
                                if (
                                    (filters.state &&
                                        filters.state !== 'all' &&
                                        pr.state !== filters.state) ||
                                    (filteredMembers &&
                                        !filteredMembers.includes(
                                            pr.user.login,
                                        ))
                                ) {
                                    continue; // Skip this PR
                                }

                                if (includeChanges) {
                                    const changesResponse =
                                        await octokit.rest.pulls.listFiles({
                                            owner: githubAuthDetail?.org,
                                            repo: repo.name,
                                            pull_number: pr.number,
                                        });
                                    pullRequestData.changes =
                                        changesResponse.data.map((file) => ({
                                            filename: file.filename,
                                            additions: file.additions,
                                            deletions: file.deletions,
                                            changes: file.changes,
                                            patch: file.patch,
                                        }));
                                }

                                pullRequests.push(pullRequestData);
                            }
                        } catch (error) {
                            if (error.status === 404) {
                                // Pull request not found in this repository, continue searching
                                continue;
                            } else {
                                console.error(
                                    `Error fetching PR #${number} in repo ${repo.name}:`,
                                    error.message,
                                );
                            }
                        }
                    }
                }
            } else {
                // Fetch all pull requests across all repositories
                const promises = allRepositories.map(async (repo) => {
                    return await this.getAllPrMessages(
                        octokit,
                        githubAuthDetail?.org,
                        repo.name,
                        startDate,
                        endDate,
                        filters.state || 'all',
                        filteredMembers,
                    );
                });

                const results = await Promise.all(promises);

                // Process the pull requests
                pullRequests = await Promise.all(
                    results
                        .flat()
                        .sort((a, b) => {
                            return (
                                new Date(b.created_at).getTime() -
                                new Date(a.created_at).getTime()
                            );
                        })
                        .map(async (pr) => {
                            const pullRequestData: any = {
                                id: pr.id,
                                repository: pr.repository,
                                repositoryId: pr.repository,
                                pull_number: pr.number,
                                author_id: pr.user.id,
                                author_name: pr.user.login,
                                author_created_at: pr.created_at,
                                message: pr.title,
                                state: pr.state,
                                prURL: pr.pull_request.html_url,
                            };

                            if (includeChanges) {
                                const changesResponse =
                                    await octokit.rest.pulls.listFiles({
                                        owner: githubAuthDetail?.org,
                                        repo: pr.repository,
                                        pull_number: pr.number,
                                    });
                                pullRequestData.changes =
                                    changesResponse.data.map((file) => ({
                                        filename: file.filename,
                                        additions: file.additions,
                                        deletions: file.deletions,
                                        changes: file.changes,
                                        patch: file.patch,
                                    }));
                            }

                            return pullRequestData;
                        }),
                );
            }

            return pullRequests;
        } catch (err) {
            console.error(err);
            return [];
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

    async addIntegrationWithoutToken(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationEntity> {
        const authUuid = uuidv4();

        const authIntegration = await this.authIntegrationService.create({
            uuid: authUuid,
            status: true,
            authDetails: {},
            organization: {
                uuid: organizationAndTeamData.organizationId,
            },
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
            platform: PlatformType.GITHUB,
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            authIntegration: { uuid: authIntegrationId },
        });
    }

    async getRepositories(params: any): Promise<Repositories[]> {
        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );

            if (!githubAuthDetail) {
                return [];
            }

            const octokit = await this.instanceOctokit(
                params.organizationAndTeamData,
            );

            const repos = await octokit.paginate(
                octokit.rest.repos.listForOrg,
                {
                    org: githubAuthDetail?.org,
                },
            );

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.GITHUB,
                status: true,
            });

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: params.organizationAndTeamData.teamId },
                });

            return repos.map((repo) => ({
                id: repo.id.toString(),
                name: repo.name,
                http_url: repo.html_url,
                avatar_url: repo.owner.avatar_url,
                organizationName: repo.owner.login,
                default_branch: repo?.default_branch,
                language: repo?.language,
                visibility: repo.private ? 'private' : 'public',
                selected: integrationConfig?.configValue?.some(
                    (repository: { name: string }) =>
                        repository?.name === repo?.name,
                ),
            }));
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async findOneByOrganizationId(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.GITHUB,
                status: true,
            });

            if (!integration) {
                return;
            }

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    team: { uuid: organizationAndTeamData.teamId },
                    configKey: IntegrationConfigKey.INSTALLATION_GITHUB,
                });

            return integrationConfig?.configValue;
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
                platform: PlatformType.GITHUB,
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

    async findOneByOrganizationName(organizationName: string): Promise<any> {
        try {
            const integrationConfig =
                await this.integrationConfigService.findByOrganizationName(
                    organizationName?.toLocaleLowerCase()?.trim(),
                );

            const integration = await this.integrationService.findById(
                integrationConfig?.integration?.uuid,
            );

            return {
                ...integrationConfig?.configValue,
                organizationId: integration?.organization?.uuid,
            };
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async findOneByInstallId(installId: string): Promise<any> {
        try {
            const integrationConfig =
                await this.integrationConfigService.findByInstallId(installId);

            return integrationConfig?.configValue ?? {};
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async verifyConnection(
        params: any,
    ): Promise<CodeManagementConnectionStatus> {
        try {
            if (!params.organizationAndTeamData.organizationId) {
                return {
                    platformName: PlatformType.GITHUB,
                    isSetupComplete: false,
                    hasConnection: false,
                    config: {},
                };
            }

            const [githubRepositories, githubInstallation, githubOrg] =
                await Promise.all([
                    this.findOneByOrganizationAndTeamDataAndConfigKey(
                        params.organizationAndTeamData,
                        IntegrationConfigKey.REPOSITORIES,
                    ),
                    this.findOneByOrganizationAndTeamDataAndConfigKey(
                        params.organizationAndTeamData,
                        IntegrationConfigKey.INSTALLATION_GITHUB,
                    ),
                    this.integrationService.findOne({
                        organization: {
                            uuid: params.organizationAndTeamData.organizationId,
                        },
                        status: true,
                        platform: PlatformType.GITHUB,
                    }),
                ]);

            const authMode =
                githubOrg?.authIntegration?.authDetails?.authMode ||
                AuthMode.OAUTH;

            const hasRepositories = githubRepositories?.length > 0;

            const isSetupComplete =
                hasRepositories &&
                ((authMode === AuthMode.OAUTH &&
                    !!githubOrg?.authIntegration?.authDetails?.org &&
                    !!githubOrg?.authIntegration?.authDetails
                        ?.installationId) ||
                    (authMode === AuthMode.TOKEN &&
                        !!githubOrg?.authIntegration?.authDetails?.authToken));

            return {
                platformName: PlatformType.GITHUB,
                isSetupComplete,
                hasConnection: !!githubOrg,
                config: {
                    hasRepositories: hasRepositories,
                    status: githubInstallation?.installationStatus,
                },
                category: IntegrationCategory.CODE_MANAGEMENT,
            };
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async updateInstallationItems(
        body: {
            installId?: string;
            installationStatus?: InstallationStatus;
            organizationName?: string;
        },
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            await this.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.INSTALLATION_GITHUB,
                configValue: body,
                organizationAndTeamData,
            });
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async getAuthenticationOAuthToken(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<string> {
        const { organizationAndTeamData } = params;

        const githubAuthDetail: any = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        if (!githubAuthDetail) {
            throw new BadRequestException('Installation not found');
        }

        const installationAuthentication =
            await this.getInstallationAuthentication(
                githubAuthDetail.installationId,
            );

        return installationAuthentication.token;
    }

    private async getInstallationAuthentication(
        installationId: string,
        retryCount = 0,
    ): Promise<GitHubAuthResponse> {
        try {
            const cachedAuth = await this.getCachedToken(installationId);

            if (cachedAuth) {
                const isValid = await this.validateCachedToken(cachedAuth);

                if (isValid) {
                    return cachedAuth;
                }

                await this.cacheService.removeFromCache(installationId);
            }

            return await this.generateAndCacheNewToken(installationId);
        } catch (error) {
            if (
                error.message?.includes('token') &&
                retryCount < this.MAX_RETRY_ATTEMPTS
            ) {
                this.logger.warn({
                    message:
                        'Error while trying to obtain a new authentication token',
                    context: GithubService.name,
                    metadata: { installationId, retryCount },
                });

                await this.cacheService.removeFromCache(installationId);

                return this.getInstallationAuthentication(
                    installationId,
                    retryCount + 1,
                );
            }

            this.logger.error({
                message: 'Fatal error while obtaining authentication token',
                context: GithubService.name,
                error,
                metadata: { installationId, retryCount },
            });
            throw error;
        }
    }

    private async getCachedToken(
        installationId: string,
    ): Promise<GitHubAuthResponse | null> {
        return this.cacheService.getFromCache<GitHubAuthResponse>(
            installationId,
        );
    }

    private async generateAndCacheNewToken(
        installationId: string,
    ): Promise<GitHubAuthResponse> {
        const appOctokit = new Octokit({
            authStrategy: createAppAuth,
            auth: {
                appId: process.env.API_GITHUB_APP_ID,
                privateKey: process.env.API_GITHUB_PRIVATE_KEY.replace(
                    /\\n/g,
                    '\n',
                ),
                clientId: process.env.GLOBAL_GITHUB_CLIENT_ID,
                clientSecret: process.env.API_GITHUB_CLIENT_SECRET,
            },
        });

        const auth = (await appOctokit.auth({
            type: 'installation',
            installationId: parseInt(installationId),
        })) as GitHubAuthResponse;

        await this.cacheService.addToCache(installationId, auth, this.TTL);

        return auth;
    }

    private async validateCachedToken(
        auth: GitHubAuthResponse,
    ): Promise<boolean> {
        try {
            const octokit = new Octokit({
                auth: auth.token,
            });

            await octokit.rest.rateLimit.get();
            return true;
        } catch (error) {
            return false;
        }
    }

    private async instanceOctokit(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails?: GithubAuthDetail,
    ): Promise<Octokit> {
        try {
            let githubAuthDetail: GithubAuthDetail = authDetails;

            if (!authDetails) {
                githubAuthDetail = await this.getGithubAuthDetails(
                    organizationAndTeamData,
                );
            }

            if (!githubAuthDetail) {
                throw new BadRequestException('Instalation not found');
            }

            if (
                githubAuthDetail.authMode === AuthMode.OAUTH &&
                'installationId' in githubAuthDetail
            ) {
                const installationAuthentication =
                    await this.getInstallationAuthentication(
                        githubAuthDetail.installationId,
                    );

                const MyOctokit = Octokit.plugin(retry, throttling);

                const octokit = new MyOctokit({
                    // @ts-ignore
                    auth: installationAuthentication.token,
                    throttle: {
                        onRateLimit: (
                            _retryAfter,
                            options: { method: string; url: string },
                            octokit,
                        ) => {
                            octokit.log.warn(
                                `Request quota exhausted for request ${options.method} ${options.url}`,
                            );

                            return true;
                        },
                        onSecondaryRateLimit: (
                            _retryAfter,
                            options: { method: string; url: string },
                            octokit,
                        ) => {
                            octokit.log.warn(
                                `Secondary rate limit hit for request ${options.method} ${options.url}`,
                            );

                            return true;
                        },
                    },
                });

                return octokit;
            } else if (
                githubAuthDetail.authMode === AuthMode.TOKEN &&
                githubAuthDetail?.authToken
            ) {
                // Decrypt the PAT before using it
                const decryptedPAT = decrypt(githubAuthDetail?.authToken);

                const MyOctokit = Octokit.plugin(retry, throttling);

                const octokit = new MyOctokit({
                    auth: decryptedPAT,
                    throttle: {
                        onRateLimit: (
                            _retryAfter,
                            options: { method: string; url: string },
                            octokit,
                        ) => {
                            octokit.log.warn(
                                `Request quota exhausted for request ${options.method} ${options.url}`,
                            );

                            // If you decide to retry when the rate limit is reached, return true.
                            return true;
                        },
                        onSecondaryRateLimit: (
                            _retryAfter,
                            options: { method: string; url: string },
                            octokit,
                        ) => {
                            octokit.log.warn(
                                `Secondary rate limit hit for request ${options.method} ${options.url}`,
                            );

                            // Similar logic can be added here for the secondary rate limit
                            return true;
                        },
                    },
                });

                return octokit;
            } else {
                throw new BadRequestException('Unknown authentication type.');
            }
        } catch (err) {
            this.logger.error({
                message: 'Error instantiating instanceOctokit',
                context: GithubService.name,
                serviceName: 'GithubService',
                error: err,
                metadata: {
                    organizationAndTeamData,
                },
            });
            throw new BadRequestException(err);
        }
    }

    private async instanceGraphQL(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails?: GithubAuthDetail
    ): Promise<typeof graphql> {
        try {
            let githubAuthDetail: GithubAuthDetail = authDetails;

            if (!authDetails) {
                githubAuthDetail = await this.getGithubAuthDetails(
                    organizationAndTeamData,
                );
            }

            if (!githubAuthDetail) {
                throw new BadRequestException('Installation not found');
            }

            if (
                githubAuthDetail.authMode === AuthMode.OAUTH &&
                'installationId' in githubAuthDetail
            ) {
                const installationAuthentication =
                    await this.getInstallationAuthentication(
                        githubAuthDetail.installationId,
                    );

                const graphqlClient = graphql.defaults({
                    headers: {
                        authorization: `token ${installationAuthentication.token}`,
                    },
                });

                return graphqlClient;
            } else if (
                githubAuthDetail.authMode === AuthMode.TOKEN &&
                githubAuthDetail?.authToken
            ) {
                // Decrypt the PAT before using it
                const decryptedPAT = decrypt(githubAuthDetail?.authToken);

                const graphqlClient = graphql.defaults({
                    headers: {
                        authorization: `token ${decryptedPAT}`,
                    },
                });

                return graphqlClient;
            } else {
                throw new BadRequestException('Unknown authentication type.');
            }
        } catch (err) {
            this.logger.error({
                message: 'Error instantiating instanceGraphQL',
                context: GithubService.name,
                serviceName: 'GithubService',
                error: err,
                metadata: {
                    organizationAndTeamData,
                },
            });
            throw new BadRequestException(err);
        }
    }

    public async accessToken(
        code: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string | { isUserToken?: boolean }> {
        try {
            const appOctokit = await new Octokit({
                authStrategy: createAppAuth,
                auth: {
                    appId: process.env.API_GITHUB_APP_ID,
                    privateKey: process.env.API_GITHUB_PRIVATE_KEY.replace(
                        /\\n/g,
                        '\n',
                    ),
                    clientId: process.env.GLOBAL_GITHUB_CLIENT_ID,
                    clientSecret: process.env.API_GITHUB_CLIENT_SECRET,
                },
            });

            const installationAuthentication = await appOctokit.auth({
                type: 'installation',
                installationId: code,
            });

            // @ts-ignore
            const installLogin = await appOctokit.rest.apps.getInstallation({
                installation_id: parseInt(code),
            });

            if (
                installLogin?.data?.target_type?.toLocaleLowerCase() === 'user'
            ) {
                return { isUserToken: true };
            }

            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.GITHUB,
            });

            const authDetails = {
                // @ts-ignore
                authToken: installationAuthentication?.token,
                installationId:
                    // @ts-ignore
                    installationAuthentication?.installationId || null,
                // @ts-ignore
                org: installLogin?.data.account?.login || null,
            };

            if (!integration) {
                await this.addAccessToken(organizationAndTeamData, authDetails);
            } else {
                await this.updateAuthIntegration({
                    organizationAndTeamData,
                    // @ts-ignore
                    accessToken: installationAuthentication?.token,
                    authIntegrationId: integration?.authIntegration?.uuid,
                    integrationId: integration?.uuid,
                    installationId:
                        // @ts-ignore
                        installationAuthentication?.installationId,
                    // @ts-ignore
                    org: installLogin?.data.account?.login,
                });
            }

            const githubStatus = await this.findOneByOrganizationId(
                organizationAndTeamData,
            );
            if (
                githubStatus?.installationStatus === InstallationStatus.PENDING
            ) {
                await this.updateInstallationItems(
                    { installationStatus: InstallationStatus.SUCCESS },
                    organizationAndTeamData,
                );
            }

            // @ts-ignore
            return `${installationAuthentication.tokenType} - ${installationAuthentication?.token}`;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async getAllMembersByOrg(organizationAndTeamData: OrganizationAndTeamData) {
        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (!githubAuthDetail) {
                return [];
            }

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const members = await octokit.paginate(
                octokit.rest.orgs.listMembers,
                {
                    org: githubAuthDetail?.org,
                    per_page: 100,
                },
            );

            return members;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async getAllCommits(
        octokit,
        owner: string,
        repo: string,
        startDate?: string,
        endDate?: string,
        state: string = 'all',
    ): Promise<Commit[]> {
        try {
            const commits = await octokit.paginate(
                octokit.rest.repos.listCommits,
                {
                    owner,
                    repo,
                    since: startDate,
                    until: endDate,
                    per_page: 100,
                    state,
                    sort: 'created',
                    direction: 'desc',
                },
            );

            const commitsDetails = commits?.map((item) => ({
                sha: item?.id,
                commit: {
                    author: {
                        id: item?.author?.id,
                        name: item?.commit?.author?.name,
                        email: item?.commit?.author?.email,
                        date: item?.commit?.author?.date,
                    },
                    message: item?.commit?.message,
                },
            }));

            return commitsDetails;
        } catch (error) {
            console.error('Error fetching commits: ', error);
            return [];
        }
    }

    async getAllPrMessages(
        octokit,
        owner: string,
        repo: string,
        startDate?: string,
        endDate?: string,
        state: string = 'all',
        membersFilter?: { name: string; id: string | number }[],
    ): Promise<any[]> {
        let query = `repo:${owner}/${repo} type:pr`;

        const startDateOnly = startDate
            ? moment(startDate, 'YYYY-MM-DD HH:mm').format('YYYY-MM-DD')
            : null;
        const endDateOnly = endDate
            ? moment(endDate, 'YYYY-MM-DD HH:mm').format('YYYY-MM-DD')
            : null;

        if (startDateOnly && endDateOnly) {
            query += ` created:${startDateOnly}..${endDateOnly}`;
        } else if (startDateOnly) {
            query += ` created:>=${startDateOnly}`;
        } else if (endDateOnly) {
            query += ` created:<=${endDateOnly}`;
        }

        if (state && state !== 'all') {
            query += ` state:${state}`;
        }

        const pullRequests = await octokit.paginate(
            octokit.rest.search.issuesAndPullRequests,
            {
                q: query,
                sort: 'created',
                direction: 'desc',
                per_page: 100,
            },
            (response) => response.data,
        );

        const pullRequestsWithRepo = pullRequests.map((pr) => ({
            ...pr,
            repository: repo,
        }));

        if (membersFilter && membersFilter.length > 0) {
            return pullRequestsWithRepo.filter((pr) =>
                membersFilter.some(
                    (member) => pr.user && pr.user?.id === member.id,
                ),
            );
        }

        return pullRequestsWithRepo;
    }

    async getListPullRequests(
        organizationAndTeamData: OrganizationAndTeamData,
        filters?: any,
    ): Promise<any> {
        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!githubAuthDetail || !repositories) {
                return null;
            }

            const formatRepo = extractRepoNames(repositories);

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const { startDate, endDate } = filters || {};

            const promises = formatRepo.map(async (repo) => {
                return await this.getAllPrMessages(
                    octokit,
                    githubAuthDetail?.org,
                    repo,
                    startDate,
                    endDate,
                );
            });

            const results = await Promise.all(promises);

            return (
                results.flat(Infinity).sort((a, b) => {
                    return (
                        new Date(b.created_at).getTime() -
                        new Date(a.created_at).getTime()
                    );
                }) || null
            );
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async getWorkflows(organizationAndTeamData: OrganizationAndTeamData) {
        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const repositories =
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

        if (!githubAuthDetail || !repositories) {
            return null;
        }

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const formatRepo = extractRepoNames(repositories);
        const workflows = [];

        for (const repo of formatRepo) {
            let workflowsFromRepo;
            try {
                workflowsFromRepo = (
                    await octokit.actions.listRepoWorkflows({
                        owner: githubAuthDetail?.org,
                        repo: repo,
                    })
                )?.data;
            } catch (error) {
                this.logger.warn({
                    message: `Error fetching workflows for repository ${repo}: ${error}`,
                    context: GithubService.name,
                    serviceName: 'GetWorkflows',
                    metadata: {
                        teamId: organizationAndTeamData.teamId,
                        repo,
                    },
                });
                continue;
            }

            const workflowsFromRepoActive =
                workflowsFromRepo?.workflows?.filter(
                    (workflow) => workflow.state === 'active',
                );

            if (workflowsFromRepoActive.length <= 0) {
                continue;
            }

            workflows.push({
                repo: repo,
                workflows: workflowsFromRepoActive,
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

    async getReleases(organizationAndTeamData: OrganizationAndTeamData) {
        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const repositories =
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

        if (!githubAuthDetail || !repositories) {
            return null;
        }

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const formatRepo = extractRepoNames(repositories);
        const releases = [];

        for (const repo of formatRepo) {
            const releasesFromRepo = await octokit.paginate(
                octokit.repos.listReleases,
                {
                    owner: githubAuthDetail?.org,
                    repo: repo,
                },
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

    async getDataForCalculateDeployFrequency(
        params: any,
    ): Promise<DeployFrequency[]> {
        try {
            let deployFrequency: DeployFrequency[] = [];

            const { organizationAndTeamData, doraMetricsConfig } = params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) {
                return;
            }

            const formatRepo = extractRepoNames(repositories);

            const teamConfig = await this.parameterService.findOne({
                configKey: ParametersKey.DEPLOYMENT_TYPE,
                team: {
                    uuid: organizationAndTeamData?.teamId,
                },
            });

            const startDate = moment(
                doraMetricsConfig?.analysisPeriod?.startTime,
            ).format('YYYY-MM-DD');
            const endDate = moment(
                doraMetricsConfig?.analysisPeriod?.endTime,
            ).format('YYYY-MM-DD');

            const deployFrequencyPromises = formatRepo
                .map((repo) => {
                    const workflow =
                        teamConfig?.configValue?.value?.workflows.find(
                            (config: any) => config.repo === repo,
                        );

                    if (
                        teamConfig?.configValue?.type === 'deployment' &&
                        !workflow &&
                        !workflow?.id
                    ) {
                        return;
                    }

                    return this.getRepoData(
                        octokit,
                        githubAuthDetail,
                        repo,
                        teamConfig,
                        startDate,
                        endDate,
                    );
                })
                ?.filter((deployFrequencyPromise) => !!deployFrequencyPromise);

            const deployFrequencyResults = await Promise.all(
                deployFrequencyPromises,
            );
            deployFrequency = deployFrequencyResults.flat();

            return deployFrequency.filter((deploy) => !!deploy);
        } catch (error) {
            this.logger.error({
                message: `Error getDataForCalculateDeployFrequency`,
                context: GithubService.name,
                error: error,
                metadata: {
                    ...params.organizationAndTeamData,
                },
            });
        }
    }

    async getCommitsByReleaseMode(
        params: any,
    ): Promise<CommitLeadTimeForChange[]> {
        try {
            const { organizationAndTeamData, deployFrequencyData } = params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) {
                return;
            }

            const formatRepo = extractRepoNames(repositories);
            let commitsLeadTimeForChange: CommitLeadTimeForChange[] = [];

            for (let index = 0; index < formatRepo.length; index++) {
                const repo = formatRepo[index];

                const deployFrequencyFiltered = deployFrequencyData.filter(
                    (deployFrequency) => deployFrequency.repository === repo,
                );

                const getDate = (deploy) => new Date(deploy.created_at);

                const sortDeploysByDate = (a, b) =>
                    getDate(b).getTime() - getDate(a).getTime();

                const sortedDeploys =
                    deployFrequencyFiltered.sort(sortDeploysByDate);

                for (let i = 0; i < sortedDeploys.length - 1; i++) {
                    let commits: Commit[] = [];

                    const lastDeploy = sortedDeploys[i];
                    const secondToLastDeploy = sortedDeploys[i + 1];

                    if (lastDeploy && secondToLastDeploy) {
                        if (
                            secondToLastDeploy &&
                            lastDeploy.teamConfig?.configValue?.type ===
                            'deployment'
                        ) {
                            commits = await this.getCommitsForTagName(
                                octokit,
                                githubAuthDetail?.org,
                                lastDeploy,
                                secondToLastDeploy,
                            );
                        } else if (
                            secondToLastDeploy &&
                            lastDeploy.teamConfig?.configValue?.type ===
                            'releases'
                        ) {
                            commits = await this.getCommitsForTagName(
                                octokit,
                                githubAuthDetail?.org,
                                lastDeploy,
                                secondToLastDeploy,
                            );
                        } else if (
                            secondToLastDeploy &&
                            lastDeploy.teamConfig?.configValue?.type === 'PRs'
                        ) {
                            commits = await this.getCommitsForPullRequest(
                                octokit,
                                githubAuthDetail?.org,
                                lastDeploy?.repository,
                                lastDeploy?.id,
                            );
                        }

                        if (commits.length > 0) {
                            const firstCommitDate = commits[0];

                            const commitLeadTimeForChange = {
                                lastDeploy,
                                secondToLastDeploy,
                                commit: firstCommitDate,
                            };

                            commitsLeadTimeForChange.push(
                                commitLeadTimeForChange,
                            );
                        }
                    }
                }
            }

            return commitsLeadTimeForChange;
        } catch (error) {
            this.logger.error({
                message: `Error getCommitsByReleaseMode`,
                context: GithubService.name,
                error: error,
                metadata: {
                    ...params.organizationAndTeamData,
                },
            });
        }
    }

    async getCommitsForTagName(
        octokit: any,
        owner: string,
        lastDeploy,
        secondLastDeploy,
    ): Promise<Commit[]> {
        return await this.getCommitsBetweenTags(
            octokit,
            owner,
            lastDeploy.repository,
            secondLastDeploy.tag_name,
            lastDeploy.tag_name,
        );
    }

    async getCommitsForPullRequest(
        octokit: any,
        owner: string,
        repo: string,
        pullNumber: number,
    ) {
        const commits = await octokit.paginate(octokit.pulls.listCommits, {
            owner,
            repo,
            pull_number: pullNumber,
        });

        return commits
            .map((commit) => ({
                sha: commit.sha,
                commit: {
                    author: commit.commit.author,
                    message: commit.commit.message,
                },
            }))
            .sort((a, b) => {
                return (
                    new Date(a.commit.author.date).getTime() -
                    new Date(b.commit.author.date).getTime()
                );
            });
    }

    async getCommitsBetweenTags(
        octokit,
        owner,
        repo,
        baseTag,
        headTag,
    ): Promise<Commit[]> {
        const listCommits = await octokit.paginate(
            octokit.rest.repos.compareCommitsWithBasehead,
            {
                owner,
                repo,
                basehead: `${baseTag}...${headTag}`,
            },
        );

        return listCommits
            .flatMap((response) =>
                response.commits.map((commit) => ({
                    sha: commit.sha,
                    commit: {
                        author: commit.commit.author,
                        message: commit.commit.message,
                    },
                })),
            )
            .sort((a, b) => {
                return (
                    new Date(a.commit.author.date).getTime() -
                    new Date(b.commit.author.date).getTime()
                );
            }) as Commit[];
    }

    private async getRepoData(
        octokit: any,
        githubAuthDetail: any,
        repo: string,
        teamConfig: any,
        startDate: string,
        endDate: string,
    ): Promise<DeployFrequency[]> {
        try {
            const workflow = teamConfig?.configValue?.value?.workflows.find(
                (config: any) => config.repo === repo,
            );
            let releasesFromRepo: any[] = [];

            if (teamConfig?.configValue?.type === 'deployment') {
                releasesFromRepo = await this.getDeployRuns(
                    octokit,
                    githubAuthDetail,
                    repo,
                    workflow.id,
                    startDate,
                    endDate,
                );
            } else if (teamConfig?.configValue?.type === 'releases') {
                releasesFromRepo = await this.getReleasesForDeployFrequency(
                    octokit,
                    githubAuthDetail,
                    repo,
                    startDate,
                    endDate,
                );
            } else if (teamConfig?.configValue?.type === 'PRs') {
                releasesFromRepo = await this.getAllPrMessages(
                    octokit,
                    githubAuthDetail?.org,
                    repo,
                    startDate,
                    endDate,
                    'closed',
                );
            }

            return releasesFromRepo?.map((release) => ({
                id: release.number ?? release?.id,
                created_at: release?.created_at,
                repository: repo,
                teamConfig,
                tag_name: release?.tag_name || release?.head_branch,
                published_at: release?.published_at,
            }));
        } catch (error) {
            this.logger.error({
                message: `Error getRepoData`,
                context: GithubService.name,
                error: error,
            });
        }
    }

    private async getDeployRuns(
        octokit: any,
        githubAuthDetail: any,
        repo: string,
        workflowId: number,
        startDate: string,
        endDate: string,
    ): Promise<any[]> {
        return await octokit.paginate(octokit.actions.listWorkflowRuns, {
            owner: githubAuthDetail?.org,
            repo: repo,
            workflow_id: workflowId,
            status: 'completed',
            created: `${startDate}..${endDate}`,
            per_page: 100,
        });
    }

    private async getReleasesForDeployFrequency(
        octokit: any,
        githubAuthDetail: any,
        repo: string,
        startDate: string,
        endDate: string,
    ): Promise<any[]> {
        const releases = await octokit.paginate(octokit.repos.listReleases, {
            owner: githubAuthDetail?.org,
            repo: repo,
        });

        return releases.filter((release) => {
            const releaseDate = moment(release.created_at).format('YYYY-MM-DD');

            return (
                (!startDate || releaseDate >= startDate) &&
                (!endDate || releaseDate <= endDate)
            );
        });
    }

    async getPullRequestsWithFiles(
        params,
    ): Promise<PullRequestWithFiles[] | null> {
        let repositories;

        if (!params?.organizationAndTeamData.organizationId) {
            return null;
        }

        const filters = params?.filters ?? {};
        const { startDate, endDate } = filters?.period || {};
        const prStatus = filters?.prStatus || 'all';

        const githubAuthDetail = await this.getGithubAuthDetails(
            params.organizationAndTeamData,
        );

        repositories = await this.findOneByOrganizationAndTeamDataAndConfigKey(
            params?.organizationAndTeamData,
            IntegrationConfigKey.REPOSITORIES,
        );

        if (!githubAuthDetail || !repositories) {
            return null;
        }

        const formatRepo = extractRepoNames(repositories);

        const octokit = await this.instanceOctokit(
            params?.organizationAndTeamData,
        );

        const pullRequestsWithFiles: PullRequestWithFiles[] = [];

        for (const repo of formatRepo) {
            const respositoryData = extractRepoData(
                repositories,
                repo,
                'github',
            );

            const pullRequests = await this.getAllPrMessages(
                octokit,
                githubAuthDetail.org,
                repo,
                startDate,
                endDate,
                prStatus,
            );

            const pullRequestDetails = await Promise.all(
                pullRequests.map(async (pullRequest) => {
                    const files = await this.getPullRequestFiles(
                        octokit,
                        githubAuthDetail.org,
                        repo,
                        pullRequest?.number,
                    );
                    return {
                        id: pullRequest.id,
                        pull_number: pullRequest?.number,
                        state: pullRequest?.state,
                        title: pullRequest?.title,
                        repository: repo,
                        repositoryData: respositoryData,
                        pullRequestFiles: files,
                    };
                }),
            );

            pullRequestsWithFiles.push(...pullRequestDetails);
        }

        return pullRequestsWithFiles;
    }

    private async getPullRequestFiles(
        octokit: Octokit,
        owner: string,
        repo: string,
        pull_number: number,
    ): Promise<PullRequestFile[]> {
        const files = await octokit.paginate(octokit.pulls.listFiles, {
            owner,
            repo,
            pull_number,
        });

        return files.map((file) => ({
            additions: file.additions,
            changes: file.changes,
            deletions: file.deletions,
            status: file.status,
        }));
    }

    async getChangedFilesSinceLastCommit(params: any): Promise<any | null> {
        const { organizationAndTeamData, repository, prNumber, lastCommit } =
            params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        // 1. Retrieve all commits in the Pull Request
        const { data: commits } = await octokit.pulls.listCommits({
            owner: githubAuthDetail?.org,
            repo: repository.name,
            pull_number: prNumber,
        });

        const changedFiles = [];

        // 2. Filter commits that occurred after the date of the last saved commit
        const newCommits = commits.filter(
            (commit) =>
                new Date(commit.commit.author.date) >
                new Date(lastCommit.created_at),
        );

        // 3. Iterate over the filtered commits and retrieve the differences
        for (const commit of newCommits) {
            const { data: commitData } = await octokit.repos.getCommit({
                owner: githubAuthDetail?.org,
                repo: repository.name,
                ref: commit.sha,
            });

            const commitFiles = commitData.files || [];
            changedFiles.push(...commitFiles);
        }

        // 4. Map the changes to the desired format
        return changedFiles.map((file) => {
            return {
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch,
            };
        });
    }

    async getPullRequestsForRTTM(
        params,
    ): Promise<PullRequestCodeReviewTime[] | null> {
        if (!params?.organizationAndTeamData.organizationId) {
            return null;
        }

        const filters = params?.filters ?? {};
        const { startDate, endDate } = filters?.period || {};

        const githubAuthDetail = await this.getGithubAuthDetails(
            params.organizationAndTeamData,
        );

        const repositories =
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                params?.organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

        if (!githubAuthDetail || !repositories) {
            return null;
        }

        const formatRepo = extractRepoNames(repositories);

        const octokit = await this.instanceOctokit(
            params?.organizationAndTeamData,
        );

        const pullRequestCodeReviewTime: PullRequestCodeReviewTime[] = [];

        for (const repo of formatRepo) {
            const pullRequests = await this.getAllPrMessages(
                octokit,
                githubAuthDetail.org,
                repo,
                startDate,
                endDate,
                'closed',
            );

            const pullRequestsFormatted = pullRequests?.map((pullRequest) => ({
                id: pullRequest.id,
                created_at: pullRequest.created_at,
                closed_at: pullRequest.closed_at,
            }));

            pullRequestCodeReviewTime.push(...pullRequestsFormatted);
        }

        return pullRequestCodeReviewTime;
    }

    async getPullRequestByNumber(params: any): Promise<any | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const pullRequest = (await octokit.rest.pulls.get({
            owner: githubAuthDetail?.org,
            repo: repository?.name,
            pull_number: prNumber,
        })) as any;

        return pullRequest?.data ?? null;
    }

    async getFilesByPullRequestId(params: any): Promise<any[] | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
            owner: githubAuthDetail?.org,
            repo: repository?.name,
            pull_number: prNumber,
        });

        return files.map((file) => ({
            filename: file.filename,
            sha: file?.sha ?? null,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
        }));
    }

    formatCodeBlock(language: string, code: string) {
        return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    formatSub(text: string) {
        return `<sub>${text}</sub>\n\n`;
    }

    formatBodyForGitHub(lineComment: any, repository: any, translations: any) {
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

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const translations = getTranslationsForLanguageByCategory(
            language as LanguageValue,
            TranslationsCategory.ReviewComment,
        );

        const bodyFormatted = this.formatBodyForGitHub(
            lineComment,
            repository,
            translations,
        );

        try {
            const comment = await octokit.pulls.createReviewComment({
                owner: githubAuthDetail?.org,
                repo: repository.name,
                pull_number: prNumber,
                body: bodyFormatted,
                commit_id: commit?.sha,
                path: lineComment.path,
                start_line: this.sanitizeLine(lineComment.start_line),
                line: this.sanitizeLine(lineComment.line),
                side: 'RIGHT',
                start_side: 'RIGHT',
            });

            this.logger.log({
                message: `Created line comment for PR#${prNumber}`,
                context: GithubService.name,
                metadata: { ...params },
            });

            if (githubAuthDetail?.authMode !== 'token') {
                await this.addThumbsReactions({
                    octokit,
                    owner: githubAuthDetail?.org,
                    repo: repository.name,
                    comment_id: comment.data.id,
                    prNumber,
                });
            }

            return {
                id: comment?.data?.id,
                pullRequestReviewId:
                    comment?.data?.pull_request_review_id?.toString(),
                body: comment?.data?.body,
                createdAt: comment?.data?.created_at,
                updatedAt: comment?.data?.updated_at,
            };
        } catch (error) {
            const isLineMismatch =
                error.message.includes('line must be part of the diff') ||
                error.message.includes(
                    'start_line must be part of the same hunk as the line',
                );

            const errorType = isLineMismatch
                ? 'failed_lines_mismatch'
                : 'failed';

            this.logger.error({
                message: `Error creating line comment for PR#${prNumber}`,
                context: GithubService.name,
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

    async getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Partial<Repository>,
        prNumber: number,
    }): Promise<PullRequestReviewComment[] | null> {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
        } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        try {
            const reviewComments = await octokit.pulls.listReviewComments({
                owner: githubAuthDetail?.org,
                repo: repository.name,
                pull_number: prNumber,
                per_page: 100,
                page: 1
            });

            return reviewComments.data.map((comment) => ({
                id: comment.id,
                body: comment.body,
                created_at: comment.created_at,
                updated_at: comment.updated_at,
                author: {
                    id: comment.user.id,
                    name: comment.user?.name,
                    username: comment.user?.login,
                }
            }));
        } catch (error) {
            this.logger.error({
                message: `Error retrieving review comments for PR#${prNumber}`,
                context: GithubService.name,
                error: error,
                metadata: {
                    ...params,
                },
            });

            return null;
        }

    }

    async getPullRequestReviewThreads(params: {
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Partial<Repository>,
        prNumber: number,
    }): Promise<PullRequestReviewComment[] | null> {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
        } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const graphql = await this.instanceGraphQL(organizationAndTeamData);

        const query = `
           query ($owner: String!, $name: String!, $number: Int!, $cursor: String) {
              repository(owner: $owner, name: $name) {
                pullRequest(number: $number) {
                  reviewThreads(first: 100, after: $cursor) {
                    nodes {
                      id
                      isResolved
                      isOutdated
                      comments(first: 100) {
                        nodes {
                          id
                          fullDatabaseId
                          body
                        }
                      }
                    }
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                  }
                }
              }
            }
        `;

        const variables = {
            owner: githubAuthDetail?.org,
            name: repository.name,
            number: prNumber,
            cursor: null, // Start with no cursor
        };

        const allReviewComments: PullRequestReviewComment[] = [];

        try {
            let hasNextPage = true;

            while (hasNextPage) {
                const response: any = await graphql(query, variables);
                const reviewThreads = response.repository.pullRequest.reviewThreads.nodes;

                const reviewComments: PullRequestReviewComment[] = reviewThreads.map((reviewThread) => {
                    const firstComment = reviewThread.comments.nodes[0];

                    // The same resource in graphQL API and REST API have different ids.
                    // So we need one of them to actually mark the thread as resolved and the other to match the id we saved in the database.
                    return firstComment ? {
                        id: firstComment.id, // Used to actually resolve the thread
                        threadId: reviewThread.id,
                        isResolved: reviewThread.isResolved,
                        isOutdated: reviewThread.isOutdated,
                        fullDatabaseId: firstComment.fullDatabaseId, // The REST API id, used to match comments saved in the database.
                        body: firstComment.body,
                    } : null;
                }).filter(comment => comment !== null);

                allReviewComments.push(...reviewComments);

                // Check if there are more pages
                hasNextPage = response.repository.pullRequest.reviewThreads.pageInfo.hasNextPage;
                variables.cursor = response.repository.pullRequest.reviewThreads.pageInfo.endCursor; // Update cursor for next request
            }

            return allReviewComments;
        } catch (error) {
            this.logger.error({
                message: `Error retrieving review comments for PR#${prNumber}`,
                context: GithubService.name,
                error: error,
                metadata: {
                    ...params,
                },
            });

            return null;
        }
    }


    async getPullRequestsWithChangesRequested(params: {
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Partial<Repository>,
    }): Promise<PullRequestsWithChangesRequested[] | null> {
        const {
            organizationAndTeamData,
            repository,
        } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const graphql = await this.instanceGraphQL(organizationAndTeamData);

        const query = `
           query ($owner: String!, $name: String!) {
                repository(owner: $owner, name: $name) {
                    pullRequests(first: 100, states: OPEN) {
                        nodes {
                            title
                            number
                            reviewDecision
                        }
                    }
                }
            }
        `;

        const variables = {
            owner: githubAuthDetail?.org,
            name: repository.name,
        };

        try {
            const response: any = await graphql(query, variables);

            const prs: PullRequestsWithChangesRequested[] = response.repository.pullRequests.nodes;

            const prsWithRequestedChanges = prs.filter((pr) => pr.reviewDecision === PullRequestReviewState.CHANGES_REQUESTED);

            return prsWithRequestedChanges;
        } catch (error) {
            this.logger.error({
                message: `Error retrieving open PRs with requested_change for repository: ${repository.name}}`,
                context: GithubService.name,
                error: error,
                metadata: {
                    ...params,
                },
            });

            return null;
        }
    }


    private sanitizeLine(line: string | number): number {
        return typeof line === 'string' ? parseInt(line, 10) : line;
    }

    async addThumbsReactions(params: {
        octokit: any;
        owner: string;
        repo: string;
        comment_id: number;
        prNumber: number;
    }): Promise<void> {
        try {
            await params.octokit.reactions.createForPullRequestReviewComment({
                owner: params.owner,
                repo: params.repo,
                comment_id: params.comment_id,
                content: GitHubReaction.THUMBS_UP,
            });

            await params.octokit.reactions.createForPullRequestReviewComment({
                owner: params.owner,
                repo: params.repo,
                comment_id: params.comment_id,
                content: GitHubReaction.THUMBS_DOWN,
            });

            this.logger.log({
                message: `Added reactions to comment ${params.comment_id} for PR#${params.prNumber}`,
                context: GithubService.name,
            });
        } catch (error) {
            this.logger.error({
                message: `Error adding reactions to comment ${params.comment_id} for PR#${params.prNumber}`,
                context: GithubService.name,
                error: error,
                metadata: params,
            });
        }
    }

    async updateDescriptionInPullRequest(params: any): Promise<any | null> {
        const { organizationAndTeamData, repository, prNumber, summary } =
            params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const response = await octokit.rest.pulls.update({
            owner: githubAuthDetail.org,
            repo: repository.name,
            pull_number: prNumber,
            body: summary,
        });

        return response;
    }

    async createCommentInPullRequest(params: any): Promise<any | null> {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
            overallComment,
        } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const response = (await octokit.rest.pulls.createReview({
            owner: githubAuthDetail?.org,
            repo: repository?.name,
            pull_number: prNumber,
            body: overallComment,
            event: 'COMMENT',
        })) as any;

        return response;
    }

    async getRepositoryContentFile(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, file, pullRequest } =
                params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            try {
                // First, try to fetch from the head branch of the PR
                const lines = (await octokit.repos.getContent({
                    owner: githubAuthDetail?.org,
                    repo: repository.name,
                    path: file.filename,
                    ref: pullRequest.head.ref,
                })) as any;

                return lines;
            } catch (error) {
                this.logger.error({
                    message: 'Error getting file content from pull request',
                    context: GithubService.name,
                    error,
                    metadata: { ...params },
                });

                // If it fails, try to fetch from the base branch
                const lines = (await octokit.repos.getContent({
                    owner: githubAuthDetail?.org,
                    repo: repository.name,
                    path: file.filename,
                    ref: pullRequest.base.ref,
                })) as any;

                return lines;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error getting file content to branch base',
                context: GithubService.name,
                error,
                metadata: { ...params },
            });
        }
    }

    private shouldIndexRepositories(params: any): boolean {
        return (
            params.configKey === IntegrationConfigKey.REPOSITORIES &&
            params?.configValue?.length > 0
        );
    }

    async getCommitsForPullRequestForCodeReview(
        params: any,
    ): Promise<any[] | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const commits = await octokit.paginate(octokit.pulls.listCommits, {
            owner: githubAuthDetail?.org,
            repo: repository?.name,
            sort: 'created',
            direction: 'asc',
            pull_number: prNumber,
        });

        return commits
            ?.map((commit) => ({
                sha: commit?.sha,
                created_at: commit?.commit?.author?.date,
                message: commit?.commit?.message,
                author: {
                    id: commit?.author?.id,
                    ...commit?.commit?.author,
                    username: commit?.author?.login,
                },
            }))
            ?.sort((a, b) => {
                return (
                    new Date(a?.author?.date).getTime() -
                    new Date(b?.author?.date).getTime()
                );
            });
    }

    async createIssueComment(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, body } =
                params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const response = await octokit.issues.createComment({
                owner: githubAuthDetail?.org,
                repo: repository.name,
                issue_number: prNumber,
                body,
            });

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error creating the comment:',
                context: GithubService.name,
                serviceName: 'GithubService createIssueComment',
                error: error,
                metadata: {
                    ...params,
                },
            });
        }
    }

    async updateIssueComment(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, commentId, body } =
                params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            await octokit.issues.updateComment({
                owner: githubAuthDetail?.org,
                repo: repository?.name,
                comment_id: commentId,
                body,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error editing the comment:',
                context: GithubService.name,
                serviceName: 'GithubService updateIssueComment',
                error: error,
                metadata: {
                    ...params,
                },
            });
        }
    }

    async markReviewCommentAsResolved(params: any): Promise<any | null> {
        const { organizationAndTeamData, commentId } = params;
        const graphql = await this.instanceGraphQL(organizationAndTeamData);

        const mutation = `
            mutation ResolveReviewThread($input: ResolveReviewThreadInput!) {
                resolveReviewThread(input: $input) {
                    clientMutationId
                    thread {
                        id
                        isResolved
                    }
                }
            }
        `;

        try {
            const response = await graphql(mutation, {
                input: {
                    threadId: commentId,
                },
            });

            return response || null;
        } catch (error) {
            this.logger.error({
                message: 'Error resolving review thread',
                context: GithubService.name,
                serviceName: 'GithubService',
                error: error,
                metadata: {
                    organizationAndTeamData,
                    commentId,
                },
            });
            throw new BadRequestException('Failed to resolve review thread.');
        }

    }




    async findTeamAndOrganizationIdByConfigKey(
        params: any,
    ): Promise<IntegrationConfigEntity | null> {
        try {
            if (!params?.repository) {
                return null;
            }

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

    async getDefaultBranch(params: any): Promise<string> {
        const { organizationAndTeamData, repository } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const response = await octokit.repos.get({
            owner: githubAuthDetail?.org,
            repo: repository?.name,
        });

        return response?.data?.default_branch;
    }

    async getPullRequestReviewComment(params: any): Promise<any[]> {
        const { organizationAndTeamData, filters } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const comments = await octokit.paginate(
            octokit.pulls.listReviewComments,
            {
                owner: githubAuthDetail?.org,
                repo: filters?.repository?.name ?? filters?.repository,
                pull_number: filters?.pullRequestNumber,
                per_page: 200, // You can adjust this value as needed
            },
        );

        return comments;
    }

    async createResponseToComment(params: any): Promise<any | null> {
        const {
            organizationAndTeamData,
            prNumber,
            inReplyToId,
            body,
            repository,
        } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const response = await octokit.pulls.createReplyForReviewComment({
            owner: githubAuthDetail?.org,
            repo: repository?.name,
            pull_number: prNumber,
            comment_id: inReplyToId,
            body: body,
        });

        return response.data;
    }

    async getPullRequestDetails(
        params: any,
    ): Promise<PullRequestDetails | null> {
        const githubAuthDetail = await this.getGithubAuthDetails(
            params.organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(
            params.organizationAndTeamData,
        );

        const response = await octokit.pulls.get({
            owner: githubAuthDetail.org, // Name of the organization or user
            repo: params.repository.name, // Repository name
            pull_number: params.prNumber, // Pull Request ID
        });

        return response.data;
    }

    async createPullRequestWebhook(params: any) {
        const { organizationAndTeamData } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const repositories = <Repositories[]>(
            await this.findOneByOrganizationAndTeamDataAndConfigKey(
                params?.organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            )
        );

        const webhookUrl = process.env.API_GITHUB_CODE_MANAGEMENT_WEBHOOK; // Replace with your webhook URL

        try {
            for (const repo of repositories) {
                const { data: webhooks } = await octokit.repos.listWebhooks({
                    owner: githubAuthDetail.org,
                    repo: repo.name,
                });

                const webhookToDelete = webhooks.find(
                    (webhook) => webhook.config.url === webhookUrl,
                );

                if (webhookToDelete) {
                    await octokit.repos.deleteWebhook({
                        owner: githubAuthDetail.org,
                        repo: repo.name,
                        hook_id: webhookToDelete.id,
                    });
                }

                const response = await octokit.repos.createWebhook({
                    owner: githubAuthDetail.org,
                    repo: repo.name,
                    config: {
                        url: webhookUrl,
                        content_type: 'json',
                        insecure_ssl: '0', // "1" if SSL is not available
                    },
                    events: [
                        'push',
                        'pull_request',
                        'issue_comment',
                        'pull_request_review_comment',
                        'pull_request_review',
                    ],
                    active: true,
                });

                this.logger.log({
                    message: `Webhook adicionado ao projeto ${repo.id}`,
                    context: GithubService.name,
                    metadata: {
                        ...params,
                        ...response?.data?.config,
                        ...response?.data?.events,
                    },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error to create webhook:',
                context: GithubService.name,
                serviceName: 'Github service createPullRequestWebhook',
                error: error,
                metadata: {
                    ...params,
                },
            });
            throw error;
        }
    }

    async countReactions(params: any) {
        const { comments, pr } = params;
        const githubAuthDetail = await this.getGithubAuthDetails(
            params.organizationAndTeamData,
        );
        const isOAuth = githubAuthDetail?.authMode === 'oauth';

        return comments
            .filter((comment) => {
                if (!isOAuth) return comment.reactions.total_count > 0;

                const adjustedThumbsUp =
                    comment.reactions[GitHubReaction.THUMBS_UP] - 1;
                const adjustedThumbsDown =
                    comment.reactions[GitHubReaction.THUMBS_DOWN] - 1;
                return adjustedThumbsUp > 0 || adjustedThumbsDown > 0;
            })
            .map((comment) => ({
                reactions: {
                    thumbsUp: isOAuth
                        ? Math.max(
                            0,
                            comment.reactions[GitHubReaction.THUMBS_UP] - 1,
                        )
                        : comment.reactions[GitHubReaction.THUMBS_UP],
                    thumbsDown: isOAuth
                        ? Math.max(
                            0,
                            comment.reactions[GitHubReaction.THUMBS_DOWN] - 1,
                        )
                        : comment.reactions[GitHubReaction.THUMBS_DOWN],
                },
                comment: {
                    id: comment.id,
                    body: comment.body,
                    pull_request_review_id: comment.pull_request_review_id,
                },
                pullRequest: {
                    id: pr.id,
                    number: pr.pull_number,
                    repository: {
                        id: pr.repository_id,
                        fullName: pr.repository,
                    },
                },
            }));
    }

    async getRepositoryAllFiles(params: {
        repository: string;
        organizationName: string;
        branch: string;
        organizationAndTeamData: OrganizationAndTeamData;
        filePatterns?: string[];
        excludePatterns?: string[];
        maxFiles?: number;
    }): Promise<any> {
        try {
            const { organizationName, repository, organizationAndTeamData } =
                params;

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const { data: tree } = await octokit.rest.git.getTree({
                owner: organizationName,
                repo: repository,
                tree_sha: params.branch,
                recursive: 'true',
            });

            if (!tree.tree) {
                return [];
            }

            let files = tree.tree
                .filter((item) => item.type === 'blob')
                .map((item) => ({
                    path: item.path,
                    type: item.type,
                    size: item.size,
                    sha: item.sha,
                }));

            // Apply file pattern filters
            if (params.filePatterns?.length) {
                files = files.filter((file) =>
                    params.filePatterns.some((pattern) =>
                        this.matchGlobPattern(file.path, pattern),
                    ),
                );
            }

            // Apply exclusion filters
            if (params.excludePatterns?.length) {
                files = files.filter(
                    (file) =>
                        !params.excludePatterns.some((pattern) =>
                            this.matchGlobPattern(file.path, pattern),
                        ),
                );
            }

            // Limit the number of files if necessary
            if (params.maxFiles && params.maxFiles > 0) {
                files = files.slice(0, params.maxFiles);
            }

            return files;
        } catch (error) {
            this.logger.error({
                message: 'Failed to get repository files',
                context: 'GithubService',
                error: error.message,
                metadata: params,
            });
            return [];
        }
    }

    private matchGlobPattern(path: string, pattern: string): boolean {
        const regexPattern = pattern
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')
            .replace(/\[.*?\]/g, (match) => `[${match.slice(1, -1)}]`);
        return new RegExp(`^${regexPattern}$`).test(path);
    }

    async getRepositoryAllFilesWithContent(params: {
        repository: string;
        organizationName: string;
        branch: string;
        organizationAndTeamData: OrganizationAndTeamData;
        filePatterns?: string[];
        excludePatterns?: string[];
        maxFiles?: number;
    }): Promise<any> {
        try {
            const { organizationName, repository, organizationAndTeamData } =
                params;
            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const files = await this.getRepositoryAllFiles(params);

            const filesWithContent = await Promise.all(
                files.map(async (file) => {
                    try {
                        const { data } = await octokit.rest.repos.getContent({
                            owner: organizationName,
                            repo: repository,
                            path: file.path,
                            ref: params.branch,
                        });

                        if ('content' in data) {
                            return {
                                ...file,
                                content: Buffer.from(
                                    data.content,
                                    'base64',
                                ).toString('utf-8'),
                            };
                        }

                        return file;
                    } catch (error) {
                        this.logger.error({
                            message: 'Failed to get file content',
                            context: 'GithubService',
                            error: error.message,
                            metadata: { file, params },
                        });
                        return file;
                    }
                }),
            );

            return filesWithContent;
        } catch (error) {
            this.logger.error({
                message: 'Failed to get repository files with content',
                context: 'GithubService',
                error: error.message,
                metadata: params,
            });
            return [];
        }
    }

    async mergePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }) {
        try {
            const { organizationAndTeamData, prNumber, repository } = params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            await octokit.rest.pulls.merge({
                owner: githubAuthDetail.org,
                repo: repository.name,
                pull_number: prNumber,
            });

            this.logger.log({
                message: `Merged pull request #${prNumber}`,
                context: GithubService.name,
                serviceName: 'GithubService mergePullRequest',
                metadata: params,
            });
        } catch (error) {
            this.logger.error({
                message: `Error to merge pull request #${params.prNumber}`,
                context: GithubService.name,
                serviceName: 'GithubService mergePullRequest',
                error: error.message,
                metadata: params,
            });
            throw error;
        }
    }

    async approvePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }) {
        try {
            const { organizationAndTeamData, prNumber, repository } = params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const { data: reviews } = await octokit.rest.pulls.listReviews({
                owner: githubAuthDetail.org,
                repo: repository.name,
                pull_number: prNumber,
            });

            if (reviews.length > 0) {
                const lastReview = reviews[reviews.length - 1];

                if (lastReview.state === PullRequestReviewState.APPROVED) {
                    this.logger.log({
                        message: `Pull request #${prNumber} has already been approved.`,
                        context: GithubService.name,
                        serviceName: 'GithubService approvePullRequest',
                        metadata: params,
                    });
                    return;
                }
            }

            await octokit.rest.pulls.createReview({
                owner: githubAuthDetail.org,
                repo: repository.name,
                pull_number: prNumber,
                event: 'APPROVE',
            });

            this.logger.log({
                message: `Approved pull request #${prNumber}`,
                context: GithubService.name,
                serviceName: 'GithubService approvePullRequest',
                metadata: params,
            });
        } catch (error) {
            this.logger.error({
                message: `Error to approve pull request #${params.prNumber}`,
                context: GithubService.name,
                serviceName: 'GithubService approvePullRequest',
                error: error.message,
                metadata: params,
            });
            throw error;
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
            const githubAuthDetail: any = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );

            if (!githubAuthDetail) {
                throw new BadRequestException('Instalation not found');
            }

            let installationAuthentication: GitHubAuthResponse;

            if (
                githubAuthDetail.authMode === AuthMode.OAUTH &&
                'installationId' in githubAuthDetail
            ) {
                installationAuthentication =
                    await this.getInstallationAuthentication(
                        githubAuthDetail.installationId,
                    );
            }

            const fullGithubUrl = `https://github.com/${params?.repository?.fullName}`;

            const repoPath = await this.repositoryManager.gitCloneWithAuth({
                organizationId: params?.organizationAndTeamData?.organizationId,
                repositoryId: params?.repository?.id,
                repositoryName: params?.repository?.name,
                url: fullGithubUrl,
                branch: params?.repository?.defaultBranch,
                provider: PlatformType.GITHUB,
                auth: {
                    type: githubAuthDetail.authMode,
                    org: githubAuthDetail.org,
                    token: installationAuthentication
                        ? installationAuthentication.token
                        : decrypt(githubAuthDetail.authToken),
                },
            });

            return repoPath;
        } catch (error) {
            this.logger.error({
                message: `Failed to clone repository ${params?.repository?.fullName} from Github`,
                context: 'GithubService',
                error: error.message,
                metadata: params,
            });
            return '';
        }
    }

    async requestChangesPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string },
        criticalComments: CommentResult[]
    }) {
        try {
            const { organizationAndTeamData, prNumber, repository, criticalComments } = params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const listOfCriticalIssues = this.getListOfCriticalIssues({
                criticalComments,
                orgName: githubAuthDetail.org,
                repository,
                prNumber
            });

            const requestChangeBodyTitle = '# Found critical issues please review the requested changes';

            const formattedBody = `${requestChangeBodyTitle}\n\n${listOfCriticalIssues}`.trim();

            await octokit.rest.pulls.createReview({
                owner: githubAuthDetail.org,
                repo: repository.name,
                pull_number: prNumber,
                event: 'REQUEST_CHANGES',
                body: formattedBody,
            });

            this.logger.log({
                message: `Changed status to requested changes on pull request #${prNumber}`,
                context: GithubService.name,
                serviceName: 'GithubService requestChangesPullRequest',
                metadata: params,
            });
        } catch (error) {
            this.logger.error({
                message: `Error to change status to request changes on pull request #${params.prNumber}`,
                context: GithubService.name,
                serviceName: 'GithubService requestChangesPullRequest',
                error: error.message,
                metadata: params,
            });
            throw error;
        }
    }

    getListOfCriticalIssues(params: {
        criticalComments: CommentResult[],
        orgName: string,
        repository: Partial<IRepository>,
        prNumber: number;
    }): string {
        const { criticalComments, orgName, prNumber, repository } = params;

        const criticalIssuesSummaryArray = this.getCriticalIssuesSummaryArray(criticalComments);

        const listOfCriticalIssues = criticalIssuesSummaryArray.map((criticalIssue) => {
            const commentId = criticalIssue.id;
            const summary = criticalIssue.oneSentenceSummary;

            const link = !orgName || !repository?.name || !prNumber || !commentId
                ? ''
                : `https://github.com/${orgName}/${repository.name}/pull/${prNumber}#discussion_r${commentId}`;

            const formattedItem = commentId
                ? (`- [${summary}](${link})`)
                : (`- ${summary}`)

            return formattedItem.trim();
        }).join("\n")

        return listOfCriticalIssues;
    }

    getCriticalIssuesSummaryArray(criticalComments: CommentResult[]): OneSentenceSummaryItem[] {
        const criticalIssuesSummaryArray: OneSentenceSummaryItem[] =
            criticalComments.map((comment) => {
                return {
                    id: comment.codeReviewFeedbackData.commentId,
                    oneSentenceSummary: comment.comment.suggestion.oneSentenceSummary ?? "",
                }
            });

        return criticalIssuesSummaryArray;
    }

    async getAllCommentsInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }) {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const comments = await octokit.paginate(
                octokit.issues.listComments,
                {
                    owner: githubAuthDetail.org,
                    repo: repository.name,
                    issue_number: prNumber,
                },
            );

            return comments;
        } catch (error) {
            this.logger.error({
                message: 'Error to get all comments in pull request',
                context: GithubService.name,
                serviceName: 'GithubService getAllCommentsInPullRequest',
                error: error.message,
                metadata: params,
            });
            return [];
        }
    }
    async getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any> {
        const { organizationAndTeamData, username } = params;

        try {
            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const userResponse = await octokit.rest.users.getByUsername({
                username: username,
            });

            const userData = userResponse.data;

            return userData;
        } catch (error) {
            if (error?.response?.status === 404) {
                this.logger.warn({
                    message: `Github user not found: ${username}`,
                    context: GithubService.name,
                    metadata: { username, organizationAndTeamData },
                });
                return null;
            }

            this.logger.error({
                message: `Error fetching user data for username: ${params.username}`,
                context: GithubService.name,
                serviceName: 'GithubService getUserByUsername',
                error: error.message,
                metadata: params,
            });
            throw error;
        }
    }

    getUserByEmailOrName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        email: string;
        userName: string;
    }): Promise<any> {
        throw new Error('Method not implemented.');
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

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const pullRequests = await octokit.paginate(octokit.pulls.list, {
                owner: githubAuthDetail.org,
                repo: repository.name,
                state: 'all',
                sort: 'created',
                direction: 'desc',
                per_page: 100,
            });

            return pullRequests
                .filter((pr) => {
                    const prDate = moment(pr.created_at);
                    const startDate = filters?.startDate
                        ? moment(filters.startDate)
                        : null;
                    const endDate = filters?.endDate
                        ? moment(filters.endDate)
                        : null;

                    return (
                        (!startDate ||
                            prDate.isSameOrAfter(startDate, 'day')) &&
                        (!endDate || prDate.isSameOrBefore(endDate, 'day'))
                    );
                })
                .map((pr) => ({
                    id: pr.id,
                    repository: repository.name,
                    repositoryId: repository.id,
                    pull_number: pr.number,
                    author_id: pr.user.id,
                    author_name: pr.user.login,
                    author_created_at: pr.created_at,
                    message: pr.title,
                    state: pr.state,
                }));
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests by repository',
                context: GithubService.name,
                serviceName: 'GithubService getPullRequestsByRepository',
                error: error.message,
                metadata: params,
            });
            return null;
        }
    }

    async getListOfValidReviews(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any[] | null> {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
        } = params;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const graphql = await this.instanceGraphQL(organizationAndTeamData);

        const query = `
           query ($owner: String!, $name: String!, $number: Int!) {
                repository(owner: $owner, name: $name) {
                    pullRequest(number: $number) {
                    reviews(first: 100) {
                        nodes {
                        state
                        id
                        comments(first: 100) {
                            nodes {
                            id
                            body
                            outdated
                            isMinimized
                            }
                        }
                        }
                    }
                    reviewThreads(first: 100) {
                        nodes {
                        id
                        isResolved
                        isOutdated
                        comments(first: 10) {
                            nodes {
                            id
                            body
                            }
                        }
                        }
                    }
                    state
                    reviewDecision
                    }
                }
                }
        `;

        const variables = {
            owner: githubAuthDetail?.org,
            name: repository.name,
            number: prNumber,
        };

        try {
            const response: any = await graphql(query, variables);

            const reviews = response.repository.pullRequest.reviews.nodes;
            const reviewThreads = response.repository.pullRequest.reviewThreads.nodes;

            const reviewThreadComments: PullRequestReviewComment[] = reviewThreads.map((reviewThread) => {
                const firstComment = reviewThread.comments.nodes[0];

                // The same resource in graphQL API and REST API have different ids.
                // So we need one of them to actually mark the thread as resolved and the other to match the id we saved in the database.
                return firstComment ? {
                    id: firstComment.id, // Used to actually resolve the thread
                    threadId: reviewThread.id,
                    isResolved: reviewThread.isResolved,
                    isOutdated: reviewThread.isOutdated,
                    fullDatabaseId: firstComment.fullDatabaseId, // The REST API id, used to match comments saved in the database.
                    body: firstComment.body,
                } : null;
            }).filter(comment => comment !== null);

            const reviewsThatRequestedChanges = reviews
                .filter((review) => review.state === PullRequestReviewState.CHANGES_REQUESTED)

            if (reviewsThatRequestedChanges.length < 1) {
                return [];
            }

            const reviewsComments: any[] = reviewsThatRequestedChanges.map((review) => {
                const firstComment = review?.comments?.nodes[0];

                if (!firstComment) {
                    return {
                        reviewId: review.id,
                    }
                }
                // The same resource in graphQL API and REST API have different ids.
                // So we need one of them to actually mark the thread as resolved and the other to match the id we saved in the database.
                return firstComment ? {
                    id: firstComment.id, // Used to actually resolve the thread
                    reviewId: review.id,
                    fullDatabaseId: firstComment.fullDatabaseId, // The REST API id, used to match comments saved in the database.
                    body: firstComment.body,
                } : null;
            }).filter(comment => comment !== null);

            const validReviews = reviewsComments
                .map(reviewComment => {
                    const matchingThreadComment = reviewThreadComments.find(threadComment => threadComment.id === reviewComment.id);

                    if (matchingThreadComment) {
                        return {
                            ...reviewComment,
                            isResolved: matchingThreadComment?.isResolved,
                            isOutdated: matchingThreadComment?.isOutdated
                        };
                    }

                    return null;
                })
                .filter(comment => comment !== null);
            return validReviews;

        } catch (error) {
            this.logger.error({
                message: `Error retrieving list of valid reviews for PR#${prNumber}`,
                context: GithubService.name,
                error: error,
                metadata: {
                    ...params
                },
            });

            return null;
        }
    }
}
