import {
    CommentResult,
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
import { GithubAuthDetail } from '@/core/domain/authIntegrations/types/github-auth-detail.type';
import {
    GitHubReaction,
    GitlabReaction,
} from '@/core/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { IGithubService } from '@/core/domain/github/contracts/github.service.contract';
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
import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import { CommitLeadTimeForChange } from '@/core/domain/platformIntegrations/types/codeManagement/commitLeadTimeForChange.type';
import { DeployFrequency } from '@/core/domain/platformIntegrations/types/codeManagement/deployFrequency.type';
import { GitCloneParams } from '@/core/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
import {
    OneSentenceSummaryItem,
    PullRequest,
    PullRequestAuthor,
    PullRequestCodeReviewTime,
    PullRequestFile,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequestsWithChangesRequested,
    PullRequestWithFiles,
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import {
    RepositoryFile,
    RepositoryFileWithContent,
} from '@/core/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import { IRepository } from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { CreateAuthIntegrationStatus } from '@/shared/domain/enums/create-auth-integration-status.enum';
import { InstallationStatus } from '@/shared/domain/enums/github-installation-status.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { CacheService } from '@/shared/utils/cache/cache.service';
import { getCodeReviewBadge } from '@/shared/utils/codeManagement/codeReviewBadge';
import { getLabelShield } from '@/shared/utils/codeManagement/labels';
import { getSeverityLevelShield } from '@/shared/utils/codeManagement/severityLevel';
import { decrypt, encrypt } from '@/shared/utils/crypto';
import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { CodeManagementConnectionStatus } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@/shared/utils/glob-utils';
import { extractRepoData, extractRepoNames } from '@/shared/utils/helpers';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@/shared/utils/translations/translations';
import { LLMModelProvider, LLMProviderService } from '@kodus/kodus-common/llm';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAppAuth } from '@octokit/auth-app';
import { graphql } from '@octokit/graphql';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import type { EndpointDefaults } from '@octokit/types';
import * as moment from 'moment-timezone';
import pLimit from 'p-limit';
import { v4 as uuidv4 } from 'uuid';
import { MCPManagerService } from '../../mcp/services/mcp-manager.service';
import { PinoLoggerService } from '../logger/pino.service';
import { PromptService } from '../prompt.service';
import {
    ALLOWLIST_TREES_ONLY,
    attachETagHooksAllowlist,
    ETagCacheEntry,
    ETagStore,
} from './octokit-etag-allowlist';

interface GitHubAuthResponse {
    token: string;
    expiresAt: string;
    permissions?: Record<string, string>;
    repositorySelection?: string;
}

interface PullRequestChange {
    filename: string;
    additions: number;
    deletions: number;
    changes: number;
    patch: string;
}

interface PullRequestData {
    id: number;
    repository: string;
    repositoryId: string | number;
    pull_number: number;
    author_id: number;
    author_name: string;
    author_created_at: string;
    message: string;
    state: string;
    prURL?: string;
    changes?: PullRequestChange[];
}

interface GitHubInstallationAccount {
    login: string;
    id: number;
    type: 'User' | 'Organization';
}

interface GitHubInstallationData {
    id: number;
    account: GitHubInstallationAccount;
    target_type: 'User' | 'Organization';
    target_id: number;
}

@Injectable()
@IntegrationServiceDecorator(PlatformType.GITHUB, 'codeManagement')
export class GithubService
    implements
        IGithubService,
        Omit<
            ICodeManagementService,
            | 'getOrganizations'
            | 'getUserById'
            | 'getLanguageRepository'
            | 'createSingleIssueComment'
        >
{
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

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parameterService: IParametersService,

        private readonly llmProviderService: LLMProviderService,

        private readonly cacheService: CacheService,

        private readonly promptService: PromptService,
        private readonly logger: PinoLoggerService,
        private readonly configService: ConfigService,
        private readonly mcpManagerService?: MCPManagerService,
    ) {}

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
                appId: this.configService.get<string>('API_GITHUB_APP_ID'),
                privateKey: this.configService
                    .get<string>('API_GITHUB_PRIVATE_KEY')
                    .replace(/\\n/g, '\n'),
                clientId: this.configService.get<string>(
                    'GLOBAL_GITHUB_CLIENT_ID',
                ),
                clientSecret: this.configService.get<string>(
                    'API_GITHUB_CLIENT_SECRET',
                ),
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
                params.type,
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

            this.mcpManagerService?.createKodusMCPIntegration(
                params.organizationAndTeamData.organizationId,
            );

            return res;
        } catch (err) {
            this.logger.error({
                message:
                    'Failed to list repositories when creating integration',
                context: GithubService.name,
                serviceName: GithubService.name,
                error: err,
                metadata: params,
            });
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

            // Removed restriction for personal accounts - now we support both organizations and personal accounts
            // Detectar tipo de conta e cachear no authDetails
            const installationData =
                installLogin.data as GitHubInstallationData;
            const accountLogin = installationData.account.login;
            const accountType =
                installationData.target_type.toLowerCase() === 'user'
                    ? 'user'
                    : 'organization';

            const authDetails = {
                // @ts-ignore
                authToken: installationAuthentication?.token,
                installationId:
                    // @ts-ignore
                    installationAuthentication?.installationId || null,
                // @ts-ignore
                org: accountLogin || null,
                authMode: params.authMode || AuthMode.OAUTH,
                accountType: accountType as 'organization' | 'user',
            };

            const repoPermissions = await this.checkRepositoryPermissions({
                organizationAndTeamData: params.organizationAndTeamData,
                org: accountLogin,
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

            const user = await userOctokit.rest.users.getAuthenticated();

            const orgs = await userOctokit.rest.orgs.listForAuthenticatedUser();

            const accountLogin = orgs?.data[0]?.login || user.data.login;

            // Detectar tipo de conta: se tem orgs é organização, senão é conta pessoal
            const accountType = orgs?.data[0]?.login ? 'organization' : 'user';

            const encryptedPAT = encrypt(token);

            const authDetails = {
                authToken: encryptedPAT,
                org: accountLogin,
                authMode: params.authMode || AuthMode.TOKEN,
                accountType: accountType as 'organization' | 'user',
            };

            const repoPermissions = await this.checkRepositoryPermissions({
                organizationAndTeamData: params.organizationAndTeamData,
                org: accountLogin,
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

    /**
     * Verifica se um identificador é uma organização ou uma conta pessoal
     * @param identifier - nome da organização ou usuário
     * @param octokit - instância do Octokit
     * @returns true se for organização, false se for conta pessoal
     */
    private async isOrganization(
        identifier: string,
        octokit: any,
    ): Promise<boolean> {
        try {
            await octokit.rest.orgs.get({ org: identifier });
            return true;
        } catch (error) {
            // Se der erro 404, é conta pessoal
            if (error.status === 404) {
                return false;
            }
            // Para outros erros, re-propaga
            throw error;
        }
    }

    /**
     * Obtém o owner correto para operações de API GitHub
     * Para organizações: usa o nome da organização
     * Para contas pessoais: usa o nome do usuário autenticado
     * @param githubAuthDetail - detalhes de autenticação do GitHub
     * @param octokit - instância do Octokit
     * @returns owner correto para usar nas chamadas de API
     */
    private async getCorrectOwner(
        githubAuthDetail: GithubAuthDetail,
        octokit: any,
    ): Promise<string> {
        // Usar cache do accountType se disponível
        if (githubAuthDetail.accountType) {
            if (githubAuthDetail.accountType === 'organization') {
                return githubAuthDetail.org;
            } else if (githubAuthDetail.authMode === AuthMode.OAUTH) {
                return githubAuthDetail.org;
            } else {
                // Para contas pessoais, usar o nome do usuário autenticado
                const user = await octokit.rest.users.getAuthenticated();
                return user.data.login;
            }
        }

        // Para integrações legadas, assumir organização (historicamente só orgs eram permitidas)
        this.logger.log({
            message: 'Legacy integration detected - assuming organization',
            context: 'GitHubService',
            metadata: { org: githubAuthDetail.org },
        });

        return githubAuthDetail.org;
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

            // Usar cache do accountType se disponível
            let isOrgAccount = authDetails.accountType === 'organization';

            // Para integrações legadas, assumir organização (historicamente só orgs eram permitidas)
            if (!authDetails.accountType) {
                isOrgAccount = true;
                this.logger.log({
                    message:
                        'Legacy integration detected - assuming organization',
                    context: 'GitHubService',
                    metadata: { org },
                });
            }

            let repos;

            if (isOrgAccount) {
                repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
                    org,
                });
            } else {
                // Para contas pessoais, verificar o tipo de autenticação
                if (
                    authDetails.authMode === AuthMode.OAUTH &&
                    'installationId' in authDetails
                ) {
                    // Para GitHub Apps, usar a API específica que lista repos acessíveis à instalação
                    repos = await octokit.paginate(
                        octokit.rest.apps.listReposAccessibleToInstallation,
                    );
                    // A API retorna objetos com estrutura diferente, extrair os repositórios
                    repos = repos.map((item) => item.repository || item);
                } else {
                    // Para PATs, usar a API tradicional
                    repos = await octokit.paginate(
                        octokit.rest.repos.listForAuthenticatedUser,
                        { type: 'all' },
                    );
                }
            }

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
    ): Promise<{ name: string; id: string | number; type?: string }[]> {
        const members = await this.getAllMembersByOrg(
            params.organizationAndTeamData,
        );

        return members?.map((user) => {
            return {
                name: user.login,
                id: user.id,
                type: user?.type === 'Bot' ? 'bot' : 'user',
            };
        });
    }

    /**
     * Fetches all commits from GitHub based on the provided parameters.
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
            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const configuredRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !githubAuthDetail ||
                !configuredRepositories ||
                configuredRepositories.length === 0
            ) {
                this.logger.warn({
                    message: 'GitHub auth details or repositories not found.',
                    context: GithubService.name,
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
                        message: `Repository ${repository.name} not found in the list of repositories.`,
                        context: GithubService.name,
                        metadata: params,
                    });

                    return [];
                }

                reposToProcess = [foundRepo];
            }

            const octokit = await this.instanceOctokit(organizationAndTeamData);
            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            const promises = reposToProcess.map((repo) =>
                this.getCommitsByRepo({
                    octokit,
                    owner,
                    repo: repo.name,
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
                message: 'Error fetching commits from GitHub',
                context: GithubService.name,
                error,
                metadata: params,
            });

            return [];
        }
    }

    /**
     * Fetches all commits for a single Github repository based on the provided filters.
     * @param params - The parameters for fetching commits.
     * @returns A promise that resolves to an array of raw commit data.
     */
    private async getCommitsByRepo(params: {
        octokit: Octokit;
        owner: string;
        repo: string;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            author?: string;
            branch?: string;
        };
    }): Promise<
        | RestEndpointMethodTypes['repos']['listCommits']['response']['data']
        | RestEndpointMethodTypes['repos']['getCommit']['response']['data'][]
    > {
        const { octokit, owner, repo, filters = {} } = params;
        const { startDate, endDate, author, branch } = filters;

        const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
            owner,
            repo,
            author: author,
            sha: branch,
            since: startDate?.toISOString(),
            until: endDate?.toISOString(),
            per_page: 100,
        });

        return commits;
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

    /**
     * Retrieves pull requests from GitHub based on the provided parameters.
     * @param params - The parameters for fetching pull requests, including organization and team data, repository filters, and pull request filters.
     * @param params.organizationAndTeamData - The organization and team data containing organizationId and teamId.
     * @param params.repository - Optional repository filter to fetch pull requests from a specific repository.
     * @param params.filters - Optional filters for pull requests, including startDate, endDate, state, author, branch, number, id, title, repository, and url.
     * @param params.filters.startDate - The start date for filtering pull requests.
     * @param params.filters.endDate - The end date for filtering pull requests.
     * @param params.filters.state - The state of the pull requests to filter (e.g., 'open', 'closed', 'all').
     * @param params.filters.author - The author of the pull requests to filter.
     * @param params.filters.branch - The branch from which to fetch pull requests.
     * @param params.filters.number - The pull request number to retrieve.
     * @param params.filters.id - The pull request id to filter by.
     * @param params.filters.title - The pull request title to filter by (contains match).
     * @param params.filters.repository - The repository name to filter by (contains match).
     * @param params.filters.url - The pull request URL to filter by (contains match).
     * @returns A promise that resolves to an array of PullRequest objects.
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
            number?: number;
            id?: number;
            title?: string;
            repository?: string;
            url?: string;
        };
    }): Promise<PullRequest[]> {
        const { organizationAndTeamData, repository, filters = {} } = params;

        try {
            if (!organizationAndTeamData.organizationId) {
                this.logger.warn({
                    message:
                        'Organization ID is required to fetch pull requests.',
                    context: GithubService.name,
                    metadata: params,
                });

                return [];
            }

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );
            const allRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !githubAuthDetail ||
                !allRepositories ||
                allRepositories.length === 0
            ) {
                this.logger.warn({
                    message: 'GitHub auth details or repositories not found.',
                    context: GithubService.name,
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
                        context: GithubService.name,
                        metadata: params,
                    });

                    return [];
                }

                reposToProcess = [foundRepo];
            } else if (filters.repository) {
                reposToProcess = allRepositories.filter((r) =>
                    r.name
                        .toLowerCase()
                        .includes(filters.repository!.toLowerCase()),
                );

                if (reposToProcess.length === 0) {
                    this.logger.warn({
                        message: `No repositories found matching filter: ${filters.repository}`,
                        context: GithubService.name,
                        metadata: params,
                    });

                    return [];
                }
            }

            const octokit = await this.instanceOctokit(organizationAndTeamData);
            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            // If URL filter is provided, try to extract PR info from URL for optimization
            if (filters.url) {
                const urlInfo = this.parseGithubUrl(filters.url);
                if (urlInfo?.owner && urlInfo?.repo && urlInfo?.prNumber) {
                    // Direct fetch if URL contains complete PR info
                    const specificRepo = reposToProcess.find(
                        (r) =>
                            r.name === urlInfo.repo ||
                            r.name === `${urlInfo.owner}/${urlInfo.repo}`,
                    );

                    if (specificRepo) {
                        const directResult = await this.getPullRequestsByRepo({
                            octokit,
                            owner,
                            repo: specificRepo.name,
                            filters: { ...filters, number: urlInfo.prNumber },
                        });

                        const rawPullRequests = directResult.flat();
                        return rawPullRequests.map((rawPr) =>
                            this.transformPullRequest(
                                rawPr,
                                organizationAndTeamData,
                            ),
                        );
                    }
                }
            }

            const promises = reposToProcess.map((r) =>
                this.getPullRequestsByRepo({
                    octokit,
                    owner,
                    repo: r.name,
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
                message: 'Error fetching pull requests from GitHub',
                context: GithubService.name,
                error,
                metadata: params,
            });

            return [];
        }
    }

    /**
     * Retrieves pull requests from a specific GitHub repository based on the provided parameters.
     * @param params - The parameters for fetching pull requests, including the Octokit instance, owner, repository name, and optional filters.
     * @returns A promise that resolves to an array of pull request data.
     */
    private async getPullRequestsByRepo(params: {
        octokit: Octokit;
        owner: string;
        repo: string;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            state?: PullRequestState;
            author?: string;
            branch?: string;
            number?: number;
            id?: number;
            title?: string;
            url?: string;
        };
    }): Promise<
        | RestEndpointMethodTypes['pulls']['list']['response']['data']
        | RestEndpointMethodTypes['pulls']['get']['response']['data'][]
    > {
        const { octokit, owner, repo, filters = {} } = params;
        const {
            startDate,
            endDate,
            state,
            author,
            branch,
            number,
            id,
            title,
            url,
        } = filters;

        // If PR number is provided, fetch it directly for this repo
        if (number) {
            try {
                const { data: pr } = await octokit.rest.pulls.get({
                    owner,
                    repo,
                    pull_number: number,
                });

                let isValid = true;

                if (author) {
                    isValid =
                        isValid &&
                        pr.user?.login.toLowerCase() === author.toLowerCase();
                }

                if (typeof id === 'number') {
                    isValid = isValid && pr.id === id;
                }

                if (title) {
                    isValid =
                        isValid &&
                        pr.title.toLowerCase().includes(title.toLowerCase());
                }

                if (url) {
                    isValid =
                        isValid &&
                        pr.html_url.toLowerCase().includes(url.toLowerCase());
                }

                return isValid ? [pr] : [];
            } catch (error) {
                const status = (error as { status?: number })?.status;
                if (status === 404) return [];
                return [];
            }
        }

        // Use GitHub Search API for text-based filters (more efficient)
        if (title || url) {
            return this.searchPullRequestsByTitle({
                octokit,
                owner,
                repo,
                filters,
            });
        }

        // Use native API filters when possible
        const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
            owner,
            repo,
            state: state
                ? this._prStateMapReverse.get(state)
                : this._prStateMapReverse.get(PullRequestState.ALL),
            base: branch,
            sort: 'created',
            direction: 'desc',
            since: startDate?.toISOString(),
            until: endDate?.toISOString(),
            per_page: 100,
        });

        return pullRequests.filter((pr) => {
            let isValid = true;

            if (author) {
                isValid =
                    isValid &&
                    pr.user?.login.toLowerCase() === author.toLowerCase();
            }

            if (typeof id === 'number') {
                isValid = isValid && pr.id === id;
            }

            if (url) {
                isValid =
                    isValid &&
                    pr.html_url.toLowerCase().includes(url.toLowerCase());
            }

            return isValid;
        });
    }

    private async searchPullRequestsByTitle(params: {
        octokit: Octokit;
        owner: string;
        repo: string;
        filters: {
            startDate?: Date;
            endDate?: Date;
            state?: PullRequestState;
            author?: string;
            branch?: string;
            title?: string;
            id?: number;
            url?: string;
        };
    }): Promise<RestEndpointMethodTypes['pulls']['list']['response']['data']> {
        const { octokit, owner, repo, filters } = params;
        const { startDate, endDate, state, author, branch, title, id, url } =
            filters;

        let query = `is:pr repo:${owner}/${repo}`;

        if (title) {
            query += ` ${title} in:title`;
        }

        if (state && state !== PullRequestState.ALL) {
            const githubState = this._prStateMapReverse.get(state);
            if (githubState && githubState !== 'all') {
                query += ` is:${githubState}`;
            }
        }

        if (author) {
            query += ` author:${author}`;
        }

        if (branch) {
            query += ` base:${branch}`;
        }

        if (startDate) {
            query += ` created:>=${startDate.toISOString().split('T')[0]}`;
        }

        if (endDate) {
            query += ` created:<=${endDate.toISOString().split('T')[0]}`;
        }

        try {
            const searchResults = await octokit.paginate(
                octokit.rest.search.issuesAndPullRequests,
                {
                    q: query,
                    sort: 'created',
                    order: 'desc',
                    per_page: 100,
                },
            );

            const pullRequests = searchResults.filter(
                (item) => item.pull_request,
            );

            const filteredBySearch = pullRequests.filter((pr) => {
                let isValid = true;

                if (typeof id === 'number') {
                    isValid = isValid && pr.id === id;
                }

                return isValid;
            });

            const prNumbers = filteredBySearch.map((pr) => pr.number);

            const detailedPRs = await Promise.all(
                prNumbers.map(async (prNumber) => {
                    try {
                        const { data } = await octokit.rest.pulls.get({
                            owner,
                            repo,
                            pull_number: prNumber,
                        });
                        return data;
                    } catch (error) {
                        return null;
                    }
                }),
            );

            return detailedPRs.filter(
                (pr) => pr !== null,
            ) as unknown as RestEndpointMethodTypes['pulls']['list']['response']['data'];
        } catch (error) {
            this.logger.warn({
                message: 'GitHub Search API failed, falling back to list API',
                context: GithubService.name,
                error,
                metadata: { query, repo: `${owner}/${repo}` },
            });

            const pullRequests = await octokit.paginate(
                octokit.rest.pulls.list,
                {
                    owner,
                    repo,
                    state: state
                        ? this._prStateMapReverse.get(state)
                        : this._prStateMapReverse.get(PullRequestState.ALL),
                    base: branch,
                    sort: 'created',
                    direction: 'desc',
                    since: startDate?.toISOString(),
                    until: endDate?.toISOString(),
                    per_page: 100,
                },
            );

            return pullRequests.filter((pr) => {
                let isValid = true;

                if (author) {
                    isValid =
                        isValid &&
                        pr.user?.login.toLowerCase() === author.toLowerCase();
                }

                if (typeof id === 'number') {
                    isValid = isValid && pr.id === id;
                }

                if (title) {
                    isValid =
                        isValid &&
                        pr.title.toLowerCase().includes(title.toLowerCase());
                }

                if (url) {
                    isValid =
                        isValid &&
                        pr.html_url.toLowerCase().includes(url.toLowerCase());
                }

                return isValid;
            });
        }
    }

    private parseGithubUrl(
        url: string,
    ): { owner: string; repo: string; prNumber: number } | null {
        try {
            // Parse GitHub PR URLs like:
            // https://github.com/owner/repo/pull/123
            // https://github.com/owner/repo/pulls/123
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/').filter((part) => part);

            if (
                pathParts.length >= 4 &&
                urlObj.hostname === 'github.com' &&
                (pathParts[2] === 'pull' || pathParts[2] === 'pulls')
            ) {
                const owner = pathParts[0];
                const repo = pathParts[1];
                const prNumber = parseInt(pathParts[3], 10);

                if (!isNaN(prNumber)) {
                    return { owner, repo, prNumber };
                }
            }
        } catch (error) {
            // Invalid URL, ignore
        }

        return null;
    }

    async getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<PullRequestAuthor[]> {
        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );
            const allRepositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params?.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!githubAuthDetail || !allRepositories) {
                return [];
            }

            const octokit = await this.instanceOctokit(
                params?.organizationAndTeamData,
            );
            const since = new Date();
            since.setDate(since.getDate() - 60);

            const authorsSet = new Set<string>();
            const authorsData = new Map<string, PullRequestAuthor>();

            // Busca paralela otimizada
            const repoPromises = allRepositories.map(async (repo) => {
                try {
                    const { data } = await octokit.rest.pulls.list({
                        owner: githubAuthDetail?.org,
                        repo: repo.name,
                        state: 'all',
                        since: since.toISOString(),
                        per_page: 100,
                        sort: 'created',
                        direction: 'desc',
                    });

                    // Para na primeira contribuição de cada usuário
                    for (const pr of data) {
                        if (pr.user?.id) {
                            const userId = pr.user.id.toString();

                            if (!authorsSet.has(userId)) {
                                authorsSet.add(userId);
                                authorsData.set(userId, {
                                    id: pr.user.id.toString(),
                                    name: pr.user.login,
                                    type:
                                        pr.user.type === 'Bot' ? 'bot' : 'user',
                                });
                            }
                        }
                    }
                } catch (error) {
                    this.logger.error({
                        message: 'Error in getPullRequestAuthors',
                        context: GithubService.name,
                        error: error,
                        metadata: {
                            organizationAndTeamData:
                                params?.organizationAndTeamData,
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
                context: GithubService.name,
                error: err,
                metadata: {
                    organizationAndTeamData: params?.organizationAndTeamData,
                },
            });
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
            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );

            if (!githubAuthDetail) {
                return [];
            }

            const octokit = await this.instanceOctokit(
                params.organizationAndTeamData,
            );

            // Usar cache do accountType se disponível
            let isOrgAccount = githubAuthDetail.accountType === 'organization';

            // Para integrações legadas, assumir organização (historicamente só orgs eram permitidas)
            if (!githubAuthDetail.accountType) {
                isOrgAccount = true;
                this.logger.log({
                    message:
                        'Legacy integration detected - assuming organization',
                    context: 'GitHubService',
                    metadata: { org: githubAuthDetail?.org },
                });
            }

            let repos;

            if (isOrgAccount) {
                repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
                    org: githubAuthDetail?.org,
                });
            } else {
                // Para contas pessoais, verificar o tipo de autenticação
                if (
                    githubAuthDetail.authMode === AuthMode.OAUTH &&
                    'installationId' in githubAuthDetail
                ) {
                    // Para GitHub Apps, usar a API específica que lista repos acessíveis à instalação
                    repos = await octokit.paginate(
                        octokit.rest.apps.listReposAccessibleToInstallation,
                    );
                    // A API retorna objetos com estrutura diferente, extrair os repositórios
                    repos = repos.map((item) => item.repository || item);
                } else {
                    // Para PATs, usar a API tradicional
                    repos = await octokit.paginate(
                        octokit.rest.repos.listForAuthenticatedUser,
                        { type: 'all' },
                    );
                }
            }

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
                full_name: repo.full_name,
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
                lastActivityAt: (repo as any)?.pushed_at || repo.updated_at,
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
                appId: this.configService.get<string>('API_GITHUB_APP_ID'),
                privateKey: this.configService
                    .get<string>('API_GITHUB_PRIVATE_KEY')
                    .replace(/\\n/g, '\n'),
                clientId: this.configService.get<string>(
                    'GLOBAL_GITHUB_CLIENT_ID',
                ),
                clientSecret: this.configService.get<string>(
                    'API_GITHUB_CLIENT_SECRET',
                ),
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

    private makeTenantETagStore(namespace: string): ETagStore {
        const prefix = `etag:${namespace}:`;
        return {
            get: async <T>(key: string) =>
                (await this.cacheService.getFromCache<ETagCacheEntry<T>>(
                    prefix + key,
                )) ?? undefined,
            set: async <T>(
                key: string,
                value: ETagCacheEntry<T>,
                ttlSeconds?: number,
            ) =>
                this.cacheService.addToCache(
                    prefix + key,
                    value,
                    (ttlSeconds ?? 86400) * 1000,
                ),
        };
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

            const ns = `${organizationAndTeamData?.organizationId ?? 'no-org'}:${organizationAndTeamData?.teamId ?? 'no-team'}`;
            const store = this.makeTenantETagStore(ns);

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
                    request: { retries: 2 },
                    throttle: {
                        onRateLimit: (
                            retryAfter: number,
                            options: Required<EndpointDefaults>,
                            octokit: Octokit,
                            retryCount: number,
                        ) => {
                            const attempts = retryCount;
                            const jitter = Math.floor(Math.random() * 1000);

                            // Log do Octokit (mantém compatibilidade com plugin)
                            octokit.log.warn(
                                `RATE-LIMIT core: ${options.method} ${options.url} — retryAfter=${retryAfter}s attempts=${attempts}`,
                            );

                            // Log do Pino (integração com sistema de logging)
                            this.logger.warn({
                                message: `RATE-LIMIT core: ${options.method} ${options.url} — retryAfter=${retryAfter}s attempts=${attempts}`,
                                context: GithubService.name,
                                metadata: {
                                    method: options.method,
                                    url: options.url,
                                    retryAfter,
                                    attempts,
                                    organizationId:
                                        organizationAndTeamData.organizationId,
                                    teamId: organizationAndTeamData.teamId,
                                },
                            });

                            if (attempts < 2) {
                                octokit.log.info(
                                    `Retrying after ~${retryAfter}s (+${jitter}ms jitter)`,
                                );

                                this.logger.log({
                                    message: `Retrying after ~${retryAfter}s (+${jitter}ms jitter)`,
                                    context: GithubService.name,
                                    metadata: {
                                        method: options.method,
                                        url: options.url,
                                        retryAfter,
                                        jitter,
                                        attempts,
                                    },
                                });
                                return true;
                            }

                            return false;
                        },
                        onSecondaryRateLimit: (
                            retryAfter: number,
                            options: Required<EndpointDefaults>,
                            octokit: Octokit,
                            retryCount: number,
                        ) => {
                            octokit.log.error(
                                `SECONDARY-RATE-LIMIT: ${options.method} ${options.url} — wait=${retryAfter}s`,
                            );

                            this.logger.error({
                                message: `SECONDARY-RATE-LIMIT: ${options.method} ${options.url} — wait=${retryAfter}s`,
                                context: GithubService.name,
                                metadata: {
                                    method: options.method,
                                    url: options.url,
                                    retryAfter,
                                    retryCount,
                                    organizationId:
                                        organizationAndTeamData.organizationId,
                                    teamId: organizationAndTeamData.teamId,
                                },
                            });
                        },
                    },
                });

                attachETagHooksAllowlist(
                    octokit,
                    store,
                    ALLOWLIST_TREES_ONLY,
                    true,
                    24 * 60 * 60,
                );
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

                attachETagHooksAllowlist(
                    octokit,
                    store,
                    ALLOWLIST_TREES_ONLY,
                    true,
                    24 * 60 * 60,
                );
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
        authDetails?: GithubAuthDetail,
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
                    appId: this.configService.get<string>('API_GITHUB_APP_ID'),
                    privateKey: this.configService
                        .get<string>('API_GITHUB_PRIVATE_KEY')
                        .replace(/\\n/g, '\n'),
                    clientId: this.configService.get<string>(
                        'GLOBAL_GITHUB_CLIENT_ID',
                    ),
                    clientSecret: this.configService.get<string>(
                        'API_GITHUB_CLIENT_SECRET',
                    ),
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

            // Removido bloqueio para contas pessoais - agora suportamos tanto organizações quanto contas pessoais
            const installationData =
                installLogin.data as GitHubInstallationData;

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
                org: installationData.account.login || null,
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
                    org: installationData.account.login,
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

            // Usar cache do accountType se disponível
            let isOrgAccount = githubAuthDetail.accountType === 'organization';

            // Para integrações legadas, assumir organização (historicamente só orgs eram permitidas)
            if (!githubAuthDetail.accountType) {
                isOrgAccount = true;
                this.logger.log({
                    message:
                        'Legacy integration detected - assuming organization',
                    context: 'GitHubService',
                    metadata: { org: githubAuthDetail?.org },
                });
            }

            if (isOrgAccount) {
                const members = await octokit.paginate(
                    octokit.rest.orgs.listMembers,
                    {
                        org: githubAuthDetail?.org,
                        per_page: 100,
                    },
                );
                return members;
            } else {
                // Para contas pessoais, retornar o próprio usuário como "membro"
                const user = await octokit.rest.users.getAuthenticated();
                return [user.data];
            }
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
        if (!params?.organizationAndTeamData.organizationId) {
            return null;
        }

        const filters = params?.filters ?? {};
        const perRepoLimit = Math.min(Math.max(filters?.limit || 5, 1), 10);
        const useFastPath = Boolean(filters?.repositoryId || filters?.limit);
        const { startDate, endDate } = filters?.period || {};
        const prStatus = filters?.prStatus || 'all';

        const githubAuthDetail = await this.getGithubAuthDetails(
            params.organizationAndTeamData,
        );

        const repositories =
            (await this.findOneByOrganizationAndTeamDataAndConfigKey(
                params?.organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            )) || [];

        if (!githubAuthDetail || !repositories) {
            return null;
        }

        const formatRepo = extractRepoNames(repositories);
        const repoFilter = filters?.repositoryId
            ? new Set([String(filters.repositoryId)])
            : null;

        const selectedRepos = formatRepo.filter((repo) => {
            if (!repoFilter) return true;
            const data = extractRepoData(repositories, repo, 'github');
            return (
                repoFilter.has(String(data?.id)) ||
                repoFilter.has(String(data?.name)) ||
                repoFilter.has(String(repo))
            );
        });

        const octokit = await this.instanceOctokit(
            params?.organizationAndTeamData,
        );

        const pullRequestsWithFiles: PullRequestWithFiles[] = [];

        for (const repo of selectedRepos) {
            const respositoryData = extractRepoData(
                repositories,
                repo,
                'github',
            );

            // Fast path: limited PRs for specific repo/limit (used in onboarding presets)
            if (useFastPath) {
                const pullRequests =
                    (
                        await octokit.pulls.list({
                            owner: githubAuthDetail.org,
                            repo,
                            state: 'all',
                            sort: 'created',
                            direction: 'desc',
                            per_page: perRepoLimit,
                            page: 1,
                        })
                    )?.data ?? [];

                const pullRequestDetails = await Promise.all(
                    pullRequests.map(async (pullRequest) => {
                        const files = filters?.skipFiles
                            ? []
                            : await this.getPullRequestFiles(
                                  octokit,
                                  githubAuthDetail.org,
                                  repo,
                                  pullRequest?.number,
                              );
                        return {
                            id: pullRequest.id,
                            pull_number: pullRequest?.number,
                            state: pullRequest?.state as any,
                            title: pullRequest?.title,
                            repository: repo,
                            repositoryData: respositoryData,
                            pullRequestFiles: files,
                            created_at: pullRequest?.created_at,
                            updated_at: pullRequest?.updated_at,
                            closed_at: pullRequest?.closed_at,
                            merged_at: pullRequest?.merged_at,
                        };
                    }),
                );

                pullRequestsWithFiles.push(...pullRequestDetails);
                continue;
            }

            // Legacy path: full pagination for all configured repos
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
                        state: pullRequest?.state as any,
                        title: pullRequest?.title,
                        repository: repo,
                        repositoryData: respositoryData,
                        pullRequestFiles: files,
                        created_at: pullRequest?.created_at,
                        updated_at: pullRequest?.updated_at,
                        closed_at: pullRequest?.closed_at,
                        merged_at: pullRequest?.merged_at,
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
        const commits = await octokit.paginate(octokit.pulls.listCommits, {
            owner: githubAuthDetail?.org,
            repo: repository?.name,
            sort: 'created',
            direction: 'asc',
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

    formatBodyForGitHub(
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
            suggestionCopyPrompt,
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
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

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
                page: 1,
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
                },
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
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

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
                const reviewThreads =
                    response.repository.pullRequest.reviewThreads.nodes;

                const reviewComments: PullRequestReviewComment[] = reviewThreads
                    .map((reviewThread) => {
                        const firstComment = reviewThread.comments.nodes[0];

                        // The same resource in graphQL API and REST API have different ids.
                        // So we need one of them to actually mark the thread as resolved and the other to match the id we saved in the database.
                        return firstComment
                            ? {
                                  id: firstComment.id, // Used to actually resolve the thread
                                  threadId: reviewThread.id,
                                  isResolved: reviewThread.isResolved,
                                  isOutdated: reviewThread.isOutdated,
                                  fullDatabaseId: firstComment.fullDatabaseId, // The REST API id, used to match comments saved in the database.
                                  body: firstComment.body,
                              }
                            : null;
                    })
                    .filter((comment) => comment !== null);

                allReviewComments.push(...reviewComments);

                // Check if there are more pages
                hasNextPage =
                    response.repository.pullRequest.reviewThreads.pageInfo
                        .hasNextPage;
                variables.cursor =
                    response.repository.pullRequest.reviewThreads.pageInfo.endCursor; // Update cursor for next request
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
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
    }): Promise<PullRequestsWithChangesRequested[] | null> {
        const { organizationAndTeamData, repository } = params;

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

            const prs: PullRequestsWithChangesRequested[] =
                response.repository.pullRequests.nodes;

            const prsWithRequestedChanges = prs.filter(
                (pr) =>
                    pr.reviewDecision ===
                    PullRequestReviewState.CHANGES_REQUESTED,
            );

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

    async addReactionToPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reaction: GitHubReaction | GitlabReaction;
    }): Promise<void> {
        try {
            if (!params.repository.name) {
                this.logger.warn({
                    message: 'Repository name is required for GitHub reactions',
                    context: GithubService.name,
                    metadata: params,
                });
                return;
            }

            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );
            const octokit = await this.instanceOctokit(
                params.organizationAndTeamData,
            );

            await octokit.rest.reactions.createForIssue({
                owner: githubAuthDetail.org,
                repo: params.repository.name,
                issue_number: params.prNumber,
                content: params.reaction as GitHubReaction,
            });

            this.logger.log({
                message: `Added reaction ${params.reaction} to PR#${params.prNumber}`,
                context: GithubService.name,
            });
        } catch (error) {
            this.logger.error({
                message: `Error adding reaction to PR#${params.prNumber}`,
                context: GithubService.name,
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
            if (!params.repository.name) {
                this.logger.warn({
                    message: 'Repository name is required for GitHub reactions',
                    context: GithubService.name,
                    metadata: params,
                });
                return;
            }

            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );
            const octokit = await this.instanceOctokit(
                params.organizationAndTeamData,
            );

            try {
                await octokit.rest.reactions.createForIssueComment({
                    owner: githubAuthDetail.org,
                    repo: params.repository.name,
                    comment_id: params.commentId,
                    content: params.reaction as GitHubReaction,
                });

                this.logger.log({
                    message: `Added reaction ${params.reaction} to issue comment ${params.commentId}`,
                    context: GithubService.name,
                });
            } catch (issueCommentError) {
                if (issueCommentError.status === 404) {
                    await octokit.rest.reactions.createForPullRequestReviewComment(
                        {
                            owner: githubAuthDetail.org,
                            repo: params.repository.name,
                            comment_id: params.commentId,
                            content: params.reaction as GitHubReaction,
                        },
                    );

                    this.logger.log({
                        message: `Added reaction ${params.reaction} to review comment ${params.commentId}`,
                        context: GithubService.name,
                    });
                } else {
                    throw issueCommentError;
                }
            }
        } catch (error) {
            this.logger.error({
                message: `Error adding reaction to comment ${params.commentId}`,
                context: GithubService.name,
                error: error,
                metadata: params,
            });
            throw error;
        }
    }

    async removeReactionsFromPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reactions: (GitHubReaction | GitlabReaction)[];
    }): Promise<void> {
        try {
            if (!params.repository.name) {
                this.logger.warn({
                    message: 'Repository name is required for GitHub reactions',
                    context: GithubService.name,
                    metadata: params,
                });
                return;
            }

            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );
            const octokit = await this.instanceOctokit(
                params.organizationAndTeamData,
            );

            const existingReactions = await octokit.rest.reactions.listForIssue(
                {
                    owner: githubAuthDetail.org,
                    repo: params.repository.name,
                    issue_number: params.prNumber,
                },
            );

            const reactionsToRemove = existingReactions.data.filter((r: any) =>
                params.reactions.includes(r.content as GitHubReaction),
            );

            await Promise.all(
                reactionsToRemove.map((reaction) =>
                    octokit.rest.reactions.deleteForIssue({
                        owner: githubAuthDetail.org,
                        repo: params.repository.name,
                        issue_number: params.prNumber,
                        reaction_id: reaction.id,
                    }),
                ),
            );

            this.logger.log({
                message: `Removed reactions from PR#${params.prNumber}`,
                context: GithubService.name,
                metadata: { reactionsRemoved: reactionsToRemove.length },
            });
        } catch (error) {
            this.logger.error({
                message: `Error removing reactions from PR#${params.prNumber}`,
                context: GithubService.name,
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
            if (!params.repository.name) {
                this.logger.warn({
                    message: 'Repository name is required for GitHub reactions',
                    context: GithubService.name,
                    metadata: params,
                });
                return;
            }

            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );
            const octokit = await this.instanceOctokit(
                params.organizationAndTeamData,
            );

            let existingReactions;
            let isReviewComment = false;

            try {
                existingReactions =
                    await octokit.rest.reactions.listForIssueComment({
                        owner: githubAuthDetail.org,
                        repo: params.repository.name,
                        comment_id: params.commentId,
                    });
            } catch (listError) {
                if (listError.status === 404) {
                    existingReactions =
                        await octokit.rest.reactions.listForPullRequestReviewComment(
                            {
                                owner: githubAuthDetail.org,
                                repo: params.repository.name,
                                comment_id: params.commentId,
                            },
                        );
                    isReviewComment = true;
                } else {
                    throw listError;
                }
            }

            const reactionsToRemove = existingReactions.data.filter((r: any) =>
                params.reactions.includes(r.content as GitHubReaction),
            );

            if (isReviewComment) {
                await Promise.all(
                    reactionsToRemove.map((reaction) =>
                        octokit.request(
                            'DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}',
                            {
                                owner: githubAuthDetail.org,
                                repo: params.repository.name,
                                comment_id: params.commentId,
                                reaction_id: reaction.id,
                            },
                        ),
                    ),
                );
            } else {
                await Promise.all(
                    reactionsToRemove.map((reaction) =>
                        octokit.rest.reactions.deleteForIssueComment({
                            owner: githubAuthDetail.org,
                            repo: params.repository.name,
                            comment_id: params.commentId,
                            reaction_id: reaction.id,
                        }),
                    ),
                );
            }

            this.logger.log({
                message: `Removed reactions from ${isReviewComment ? 'review' : 'issue'} comment ${params.commentId}`,
                context: GithubService.name,
                metadata: { reactionsRemoved: reactionsToRemove.length },
            });
        } catch (error) {
            this.logger.error({
                message: `Error removing reactions from comment ${params.commentId}`,
                context: GithubService.name,
                error: error,
                metadata: params,
            });
            throw error;
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
                parents:
                    commit?.parents
                        ?.map((p) => ({ sha: p?.sha ?? '' }))
                        ?.filter((p) => p.sha) ?? [],
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

            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            await octokit.issues.updateComment({
                owner,
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

    async minimizeComment(params: {
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
        try {
            const {
                organizationAndTeamData,
                commentId,
                reason = 'OUTDATED',
            } = params;

            const graphql = await this.instanceGraphQL(organizationAndTeamData);

            const mutation = `
            mutation MinimizeComment($input: MinimizeCommentInput!) {
                minimizeComment(input: $input) {
                    clientMutationId
                    minimizedComment {
                        isMinimized
                        minimizedReason
                        viewerCanMinimize
                    }
                }
            }
        `;

            const response = await graphql(mutation, {
                input: {
                    subjectId: commentId,
                    classifier: reason,
                },
            });

            this.logger.log({
                message: `Successfully minimized comment ${commentId}`,
                context: GithubService.name,
                metadata: {
                    commentId,
                    reason,
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });

            return response;
        } catch (error) {
            this.logger.error({
                message: `Error minimizing comment ${params.commentId}:`,
                context: GithubService.name,
                serviceName: 'GithubService minimizeComment',
                error: error,
                metadata: {
                    ...params,
                },
            });
            throw error;
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
                    integration: {
                        status: true,
                        platform: PlatformType.GITHUB,
                    },
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
                per_page: 200,
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

    async updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        commentId: string;
        body: string;
    }) {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
            commentId,
            body,
        } = params;

        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            const updated = await octokit.pulls.updateReviewComment({
                owner,
                repo: repository?.name,
                comment_id: Number(commentId),
                body,
            });

            return updated;
        } catch (error) {
            this.logger.error({
                message: `Error updating review comment for PR#${prNumber}`,
                context: GithubService.name,
                error: error,
                metadata: {
                    ...params,
                },
            });

            return null;
        }
    }

    async getPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequest | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const response = await octokit.pulls.get({
                owner: githubAuthDetail.org, // Name of the organization or user
                repo: repository.name, // Repository name
                pull_number: prNumber, // Pull Request ID
            });

            if (!response || !response.data) {
                return null;
            }

            return this.transformPullRequest(
                response.data,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: `Error retrieving pull request details for PR#${prNumber}`,
                context: GithubService.name,
                error,
                metadata: {
                    ...params,
                },
            });

            return null;
        }
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

        const webhookUrl = this.configService.get<string>(
            'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
        );

        // Usar método centralizado para determinar o owner correto
        const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

        try {
            for (const repo of repositories) {
                const { data: webhooks } = await octokit.repos.listWebhooks({
                    owner: owner,
                    repo: repo.name,
                });

                // Verificação segura do config para evitar erro "Parameter config does not exist"
                const webhookToDelete = webhooks.find(
                    (webhook) =>
                        webhook.config && webhook.config.url === webhookUrl,
                );

                if (webhookToDelete) {
                    await octokit.repos.deleteWebhook({
                        owner: owner,
                        repo: repo.name,
                        hook_id: webhookToDelete.id,
                    });
                }

                const response = await octokit.repos.createWebhook({
                    owner: owner,
                    repo: repo.name,
                    config: {
                        url: webhookUrl,
                        content_type: 'json',
                        insecure_ssl: '0',
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
                    message: `Webhook adicionado ao repositório ${repo.name} (owner: ${owner})`,
                    context: GithubService.name,
                    metadata: {
                        ...params,
                        owner,
                        repositoryName: repo.name,
                        webhookId: response?.data?.id,
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
                    owner,
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
    }): Promise<RepositoryFile[]> {
        try {
            const {
                repository,
                organizationAndTeamData,
                filters = {},
            } = params;

            if (!repository?.name) {
                this.logger.warn({
                    message: 'Repository name is required.',
                    context: GithubService.name,
                    metadata: params,
                });

                return [];
            }

            const authDetails = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetails) {
                this.logger.warn({
                    message: 'GitHub authentication details not found.',
                    context: GithubService.name,
                    metadata: params,
                });

                return [];
            }

            const octokit = await this.instanceOctokit(organizationAndTeamData);
            const owner = await this.getCorrectOwner(authDetails, octokit);

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
                        message: 'Default branch not found.',
                        context: GithubService.name,
                        metadata: params,
                    });

                    return [];
                }
            }

            const { data: tree } = await octokit.rest.git.getTree({
                owner,
                repo: repository.name,
                tree_sha: branch,
                recursive: 'true',
            });

            if (!tree.tree) {
                this.logger.warn({
                    message: 'No files found in the repository tree.',
                    context: GithubService.name,
                    metadata: params,
                });

                return [];
            }

            let files = tree.tree
                .filter((item) => item.type === 'blob')
                .map((item) => this.transformRepositoryFile(item));

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
                message: `Retrieved ${filteredFiles.length} files from repository ${repository.name}`,
                context: GithubService.name,
                metadata: {
                    organizationAndTeamData,
                    repository: repository.name,
                    branch,
                    filePatterns,
                    excludePatterns,
                    maxFiles,
                },
            });

            return filteredFiles;
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

    async getRepositoryAllFilesWithContent(params: {
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
    }): Promise<RepositoryFileWithContent[]> {
        try {
            const {
                organizationAndTeamData,
                repository,
                filters = {},
            } = params;

            if (!repository?.name) {
                this.logger.warn({
                    message: 'Repository name is required.',
                    context: GithubService.name,
                    metadata: params,
                });

                return [];
            }

            const authDetails = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetails) {
                this.logger.warn({
                    message: 'GitHub authentication details not found.',
                    context: GithubService.name,
                    metadata: params,
                });

                return [];
            }

            const octokit = await this.instanceOctokit(organizationAndTeamData);
            const owner = await this.getCorrectOwner(authDetails, octokit);

            let { branch } = filters ?? {};

            if (!branch || branch.length === 0) {
                branch = await this.getDefaultBranch({
                    organizationAndTeamData,
                    repository,
                });

                if (!branch) {
                    this.logger.warn({
                        message: 'Default branch not found.',
                        context: GithubService.name,
                        metadata: params,
                    });

                    return [];
                }
            }

            const files = await this.getRepositoryAllFiles({
                ...params,
                filters: { ...filters, branch },
            });

            if (!files || files.length === 0) {
                this.logger.warn({
                    message: 'No files found in the repository.',
                    context: GithubService.name,
                    metadata: params,
                });

                return [];
            }

            const promises = files.map((file) =>
                this.getFileWithContent({
                    file,
                    octokit,
                    owner,
                    repo: repository.name,
                    branch,
                }),
            );

            const filesWithContent = await Promise.all(promises);

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

    private async getFileWithContent(params: {
        file: RepositoryFile;
        octokit: Octokit;
        owner: string;
        repo: string;
        branch: string;
    }): Promise<RepositoryFileWithContent> {
        const { file, octokit, owner, repo, branch } = params;

        const fileWithContent = {
            ...file,
            content: null,
        };

        try {
            const { data } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: file.path,
                ref: branch,
            });

            if ('content' in data) {
                fileWithContent.content = Buffer.from(
                    data.content,
                    'base64',
                ).toString('utf-8');
            }
        } catch (error) {
            this.logger.error({
                message: `Failed to get content for file ${file.path}`,
                context: GithubService.name,
                error: error.message,
                metadata: { file, owner, repo, branch },
            });
        }

        return fileWithContent;
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

    async getReviewStatusByPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewState | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

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
                context: GithubService.name,
                serviceName: 'GithubService getReviewStatusByPullRequest',
                metadata: {
                    repository: params.repository,
                    prNumber: params.prNumber,
                },
            });
            return null;
        }

        const githubAuth = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(
            organizationAndTeamData,
            githubAuth,
        );

        const graphQLWithAuth = await this.instanceGraphQL(
            organizationAndTeamData,
        );

        const query = `
        query {
          viewer {
            login
            id
            __typename
          }
        }
      `;

        const userAuth: {
            viewer: { login: string; id: string };
        } = await graphQLWithAuth(query);

        const { data: allReviews } = await octokit.rest.pulls.listReviews({
            owner: githubAuth.org,
            repo: repository.name,
            pull_number: prNumber,
            per_page: 100,
        });

        if (!allReviews?.length) {
            return null;
        }

        const myReviews = allReviews
            ?.filter(
                (review) =>
                    review?.user?.login === userAuth?.viewer?.login &&
                    review?.user?.node_id === userAuth?.viewer?.id,
            )
            ?.sort(
                (a, b) =>
                    new Date(a.submitted_at).getTime() -
                    new Date(b.submitted_at).getTime(),
            );

        if (!myReviews?.length) {
            return null;
        }

        const lastReview = myReviews.pop();

        switch (lastReview?.state) {
            case 'APPROVED':
                return PullRequestReviewState.APPROVED;
            case 'CHANGES_REQUESTED':
                return PullRequestReviewState.CHANGES_REQUESTED;
            case 'COMMENTED':
                return PullRequestReviewState.COMMENTED;
            case 'DISMISSED':
                return PullRequestReviewState.DISMISSED;
            case 'PENDING':
                return PullRequestReviewState.PENDING;
            default:
                return null;
        }
    }

    async checkIfPullRequestShouldBeApproved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }): Promise<any | null> {
        const { organizationAndTeamData, prNumber, repository } = params;

        const reviewStatus = await this.getReviewStatusByPullRequest({
            organizationAndTeamData,
            repository,
            prNumber,
        });

        if (reviewStatus === PullRequestReviewState.APPROVED) {
            this.logger.log({
                message: `PR#${prNumber} already approved`,
                context: GithubService.name,
                serviceName:
                    'GithubService - checkIfPullRequestShouldBeApproved',
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository: {
                        name: repository.name,
                        id: repository.id,
                    },
                },
            });

            return;
        }

        this.logger.log({
            message: `Approving PR#${prNumber}`,
            context: GithubService.name,
            serviceName: 'GithubService - approvePullRequest',
            metadata: {
                organizationAndTeamData,
                prNumber,
                repository: {
                    name: repository.name,
                    id: repository.id,
                },
            },
        });

        await this.approvePullRequest({
            organizationAndTeamData,
            prNumber,
            repository,
        });
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

    async getCloneParams(params: {
        repository: Pick<
            Repository,
            'id' | 'defaultBranch' | 'fullName' | 'name'
        >;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<GitCloneParams> {
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

            return {
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
            };
        } catch (error) {
            this.logger.error({
                message: `Failed to clone repository ${params?.repository?.fullName} from Github`,
                context: 'GithubService',
                error: error.message,
                metadata: params,
            });
            return null;
        }
    }

    async requestChangesPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
        criticalComments: CommentResult[];
    }) {
        try {
            const {
                organizationAndTeamData,
                prNumber,
                repository,
                criticalComments,
            } = params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const listOfCriticalIssues = this.getListOfCriticalIssues({
                criticalComments,
                orgName: githubAuthDetail.org,
                repository,
                prNumber,
            });

            const requestChangeBodyTitle =
                '# Found critical issues please review the requested changes';

            const formattedBody =
                `${requestChangeBodyTitle}\n\n${listOfCriticalIssues}`.trim();

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
        criticalComments: CommentResult[];
        orgName: string;
        repository: Partial<IRepository>;
        prNumber: number;
    }): string {
        const { criticalComments, orgName, prNumber, repository } = params;

        const criticalIssuesSummaryArray =
            this.getCriticalIssuesSummaryArray(criticalComments);

        const listOfCriticalIssues = criticalIssuesSummaryArray
            .map((criticalIssue) => {
                const commentId = criticalIssue.id;
                const summary = criticalIssue.oneSentenceSummary;

                const link =
                    !orgName || !repository?.name || !prNumber || !commentId
                        ? ''
                        : `https://github.com/${orgName}/${repository.name}/pull/${prNumber}#discussion_r${commentId}`;

                const formattedItem = commentId
                    ? `- [${summary}](${link})`
                    : `- ${summary}`;

                return formattedItem.trim();
            })
            .join('\n');

        return listOfCriticalIssues;
    }

    getCriticalIssuesSummaryArray(
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

    async getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null> {
        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );

            if (!githubAuthDetail?.authToken) {
                return null;
            }

            const token = decrypt(githubAuthDetail.authToken);
            const userOctokit = new Octokit({ auth: token });
            const { data } = await userOctokit.rest.users.getAuthenticated();

            return data || null;
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving current GitHub user',
                context: GithubService.name,
                serviceName: 'GithubService getCurrentUser',
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
    }): Promise<PullRequest[]> {
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
                .map((pr) =>
                    this.transformPullRequest(pr, organizationAndTeamData),
                );
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
        const { organizationAndTeamData, repository, prNumber } = params;

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
            const reviewThreads =
                response.repository.pullRequest.reviewThreads.nodes;

            const reviewThreadComments: PullRequestReviewComment[] =
                reviewThreads
                    .map((reviewThread) => {
                        const firstComment = reviewThread.comments.nodes[0];

                        // The same resource in graphQL API and REST API have different ids.
                        // So we need one of them to actually mark the thread as resolved and the other to match the id we saved in the database.
                        return firstComment
                            ? {
                                  id: firstComment.id, // Used to actually resolve the thread
                                  threadId: reviewThread.id,
                                  isResolved: reviewThread.isResolved,
                                  isOutdated: reviewThread.isOutdated,
                                  fullDatabaseId: firstComment.fullDatabaseId, // The REST API id, used to match comments saved in the database.
                                  body: firstComment.body,
                              }
                            : null;
                    })
                    .filter((comment) => comment !== null);

            const reviewsThatRequestedChanges = reviews.filter(
                (review) =>
                    review.state === PullRequestReviewState.CHANGES_REQUESTED,
            );

            if (reviewsThatRequestedChanges.length < 1) {
                return [];
            }

            const reviewsComments: any[] = reviewsThatRequestedChanges
                .map((review) => {
                    const firstComment = review?.comments?.nodes[0];

                    if (!firstComment) {
                        return {
                            reviewId: review.id,
                        };
                    }
                    // The same resource in graphQL API and REST API have different ids.
                    // So we need one of them to actually mark the thread as resolved and the other to match the id we saved in the database.
                    return firstComment
                        ? {
                              id: firstComment.id, // Used to actually resolve the thread
                              reviewId: review.id,
                              fullDatabaseId: firstComment.fullDatabaseId, // The REST API id, used to match comments saved in the database.
                              body: firstComment.body,
                          }
                        : null;
                })
                .filter((comment) => comment !== null);

            const validReviews = reviewsComments
                .map((reviewComment) => {
                    const matchingThreadComment = reviewThreadComments.find(
                        (threadComment) =>
                            threadComment.id === reviewComment.id,
                    );

                    if (matchingThreadComment) {
                        return {
                            ...reviewComment,
                            isResolved: matchingThreadComment?.isResolved,
                            isOutdated: matchingThreadComment?.isOutdated,
                        };
                    }

                    return null;
                })
                .filter((comment) => comment !== null);
            return validReviews;
        } catch (error) {
            this.logger.error({
                message: `Error retrieving list of valid reviews for PR#${prNumber}`,
                context: GithubService.name,
                error: error,
                metadata: {
                    ...params,
                },
            });

            return null;
        }
    }

    async isWebhookActive(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<boolean> {
        const { organizationAndTeamData, repositoryId } = params;

        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (!githubAuthDetail) {
                return false;
            }

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories?.length) {
                return false;
            }

            const repository = repositories.find(
                (repo: Repositories) =>
                    repo.id?.toString() === repositoryId.toString(),
            );

            if (!repository) {
                return false;
            }

            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            const { data: webhooks } = await octokit.repos.listWebhooks({
                owner,
                repo: repository.name,
            });

            const webhookUrl =
                this.configService.get<string>(
                    'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
                ) ?? process.env.API_GITHUB_CODE_MANAGEMENT_WEBHOOK;

            if (!webhookUrl) {
                return false;
            }

            return webhooks.some(
                (hook) => hook?.config?.url === webhookUrl && hook?.active,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error verifying GitHub webhook status',
                context: GithubService.name,
                serviceName: 'GithubService isWebhookActive',
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
        const authDetails = await this.getGithubAuthDetails(
            params.organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(
            params.organizationAndTeamData,
        );

        const integration = await this.integrationService.findOne({
            organization: {
                uuid: params.organizationAndTeamData.organizationId,
            },
            team: { uuid: params.organizationAndTeamData.teamId },
            platform: PlatformType.GITHUB,
        });

        if (!integration?.authIntegration?.authDetails) {
            return;
        }

        const { authMode } = integration.authIntegration.authDetails;

        if (authMode === AuthMode.OAUTH) {
            if (integration.authIntegration.authDetails.installationId) {
                try {
                    const appOctokit = this.createOctokitInstance();
                    await appOctokit.apps.deleteInstallation({
                        installation_id:
                            integration.authIntegration.authDetails
                                .installationId,
                    });
                } catch (error) {
                    this.logger.error({
                        message: 'Error deleting GitHub installation',
                        context: this.deleteWebhook.name,
                        error: error,
                        metadata: {
                            organizationAndTeamData:
                                params.organizationAndTeamData,
                        },
                    });
                }
            }
        } else if (authMode === AuthMode.TOKEN) {
            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (repositories) {
                // Usar método centralizado para determinar o owner correto
                const owner = await this.getCorrectOwner(authDetails, octokit);

                for (const repo of repositories) {
                    try {
                        const { data: webhooks } =
                            await octokit.repos.listWebhooks({
                                owner: owner,
                                repo: repo.name,
                            });

                        const webhookUrl = this.configService.get<string>(
                            'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
                        );

                        const webhookToDelete = webhooks.find(
                            (webhook) =>
                                webhook.config &&
                                webhook.config.url === webhookUrl,
                        );

                        if (webhookToDelete) {
                            await octokit.repos.deleteWebhook({
                                owner: owner,
                                repo: repo.name,
                                hook_id: webhookToDelete.id,
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
                                repoId: repo.id,
                                owner,
                            },
                        });
                    }
                }
            }
        }
    }

    //#region Get Repository Tree
    async getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<any[]> {
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

            // Get repositories to find the repository name by ID
            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) {
                return [];
            }

            // Find the repository by ID
            const repository = repositories.find(
                (repo: any) => repo.id.toString() === params.repositoryId,
            );

            if (!repository) {
                return [];
            }

            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            // Get repository info to find the default branch
            const repoResponse = await octokit.rest.repos.get({
                owner,
                repo: repository.name,
            });

            // HYBRID APPROACH: Try fast recursive first, fallback to safe manual
            try {
                // Try recursive with timeout
                const recursiveResult = await Promise.race([
                    octokit.rest.git.getTree({
                        owner,
                        repo: repository.name,
                        tree_sha: repoResponse.data.default_branch,
                        recursive: 'true',
                    }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('TIMEOUT')), 10000),
                    ),
                ]);

                // Check if truncated
                if ((recursiveResult as any).data.truncated) {
                    throw new Error('TRUNCATED');
                }

                // Success with recursive
                return (recursiveResult as any).data.tree.map((item) => ({
                    path: item.path,
                    type: item.type === 'tree' ? 'directory' : 'file',
                    sha: item.sha,
                    size: item.size,
                    url: item.url,
                }));
            } catch (recursiveError) {
                // Fallback to safe manual approach
                return await this.getRepositoryTreeByLevelSafe({
                    owner,
                    repo: repository.name,
                    octokit,
                    rootTreeSha: repoResponse.data.default_branch,
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree from GitHub',
                context: GithubService.name,
                error: error,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId: params.repositoryId,
                },
            });
            return [];
        }
    }

    private async getRepositoryTreeByLevelSafe(params: {
        owner: string;
        repo: string;
        octokit: any;
        rootTreeSha: string;
    }): Promise<
        {
            path: string;
            type: 'file' | 'directory';
            sha: string;
            size?: number;
            url: string;
        }[]
    > {
        const { owner, repo, octokit, rootTreeSha } = params;
        const allItems = [];
        const limit = pLimit(3);
        let rateLimitRemaining = 5000;

        let directoriesToProcess = [{ sha: rootTreeSha, path: '' }];

        while (directoriesToProcess.length > 0) {
            // Adjust concurrency based on rate limit
            const currentLimit = rateLimitRemaining < 100 ? pLimit(1) : limit;

            const promises = directoriesToProcess.map((dir) =>
                currentLimit(async () => {
                    try {
                        // Add timeout to individual requests
                        const result = await Promise.race([
                            octokit.rest.git.getTree({
                                owner,
                                repo,
                                tree_sha: dir.sha,
                            }),
                            new Promise((_, reject) =>
                                setTimeout(
                                    () => reject(new Error('REQUEST_TIMEOUT')),
                                    30000,
                                ),
                            ),
                        ]);

                        // Update rate limit info
                        if (result.headers?.['x-ratelimit-remaining']) {
                            rateLimitRemaining = parseInt(
                                result.headers['x-ratelimit-remaining'],
                            );
                        }

                        return { parentPath: dir.path, tree: result.data.tree };
                    } catch (error) {
                        // Handle rate limiting
                        if (error.status === 403) {
                            await new Promise((resolve) =>
                                setTimeout(resolve, 60000),
                            );
                            throw error;
                        }
                        throw error;
                    }
                }),
            );

            const settledResults = await Promise.allSettled(promises);
            const nextLevelDirectories = [];

            for (const result of settledResults) {
                if (result.status === 'rejected') {
                    this.logger.error({
                        message:
                            'Error fetching tree level from GitHub (safe mode)',
                        context: GithubService.name,
                        error: result.reason,
                        metadata: { owner, repo, rateLimitRemaining },
                    });
                    continue;
                }

                const { parentPath, tree } = result.value;

                for (const item of tree) {
                    const fullPath = parentPath
                        ? `${parentPath}/${item.path}`
                        : item.path;

                    if (!item.type || !item.sha || !item.path) continue;

                    const baseItem = {
                        path: fullPath,
                        sha: item.sha,
                        size: item.size,
                        url: item.url,
                    };

                    if (item.type === 'blob') {
                        allItems.push({ ...baseItem, type: 'file' });
                    } else if (item.type === 'tree') {
                        allItems.push({ ...baseItem, type: 'directory' });
                        nextLevelDirectories.push({
                            sha: item.sha,
                            path: fullPath,
                        });
                    }
                }
            }

            directoriesToProcess = nextLevelDirectories;
        }

        return allItems;
    }

    async getRepositoryTreeByDirectory(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        directoryPath?: string;
    }): Promise<TreeItem[]> {
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

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );
            if (!repositories) {
                return [];
            }

            const repository = repositories.find(
                (repo: any) => repo.id.toString() === params.repositoryId,
            );
            if (!repository) return [];

            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            const repoResponse = await octokit.rest.repos.get({
                owner,
                repo: repository.name,
            });
            const branch = repoResponse.data.default_branch;

            const head = await octokit.rest.repos.getBranch({
                owner,
                repo: repository.name,
                branch,
            });
            const commitSha = head.data.commit.sha;

            const commit = await octokit.rest.git.getCommit({
                owner,
                repo: repository.name,
                commit_sha: commitSha,
            });
            let currentTreeSha = commit.data.tree.sha;

            if (params.directoryPath) {
                const parts = params.directoryPath.split('/').filter(Boolean);
                for (const segment of parts) {
                    const treeResp = await octokit.rest.git.getTree({
                        owner,
                        repo: repository.name,
                        tree_sha: currentTreeSha,
                    });
                    const next = treeResp.data.tree.find(
                        (i: any) => i.path === segment && i.type === 'tree',
                    );
                    if (!next) {
                        this.logger.warn({
                            message: 'Directory segment not found',
                            context: GithubService.name,
                            metadata: {
                                segment,
                                directoryPath: params.directoryPath,
                            },
                        });
                        return [];
                    }
                    currentTreeSha = next.sha;
                }
            }

            const levelResp = await octokit.rest.git.getTree({
                owner,
                repo: repository.name,
                tree_sha: currentTreeSha,
            });

            const onlyDirs = levelResp.data.tree.filter(
                (i: any) => i.type === 'tree',
            );

            const result: TreeItem[] = [];
            for (const dir of onlyDirs) {
                const childTree = await octokit.rest.git.getTree({
                    owner,
                    repo: repository.name,
                    tree_sha: dir.sha,
                });

                const hasSubdir = childTree.data.tree.some(
                    (e: any) => e.type === 'tree',
                );

                const fullPath = params.directoryPath
                    ? `${params.directoryPath}/${dir.path}`
                    : dir.path;

                result.push({
                    path: fullPath,
                    type: 'directory',
                    sha: dir.sha,
                    url: dir.url,
                    hasChildren: hasSubdir,
                } as any);
            }

            return result;
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting repository tree by directory from GitHub',
                context: GithubService.name,
                error,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId: params.repositoryId,
                    directoryPath: params.directoryPath,
                },
            });
            return [];
        }
    }
    //#endregion

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
            commentBody +=
                this.formatSub(translations.feedback) +
                '<!-- kody-codereview -->&#8203;\n&#8203;';
        }

        return Promise.resolve(commentBody.trim());
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
                message: 'Error checking if pull request is draft',
                context: GithubService.name,
                serviceName: 'GithubService isDraftPullRequest',
                error: error.message,
                metadata: params,
            });
            return false;
        }
    }

    //#region Transformers

    /**
     * Transforms a raw commit object from the Github API into the standard Commit interface.
     * @param rawCommit - The raw commit data from the Github API.
     * @returns A Commit object.
     */
    private transformCommit(
        rawCommit:
            | RestEndpointMethodTypes['repos']['getCommit']['response']['data']
            | RestEndpointMethodTypes['repos']['listCommits']['response']['data'][number],
    ): Commit {
        return {
            sha: rawCommit.sha ?? '',
            commit: {
                author: {
                    id:
                        rawCommit.author?.id?.toString() ??
                        rawCommit.committer?.id?.toString() ??
                        '',
                    date: rawCommit.commit?.author?.date ?? '',
                    email: rawCommit.commit?.author?.email ?? '',
                    name: rawCommit.commit?.author?.name ?? '',
                },
                message: rawCommit.commit?.message ?? '',
            },
            parents:
                rawCommit.parents
                    ?.map((parent) => ({
                        sha: parent?.sha ?? '',
                    }))
                    .filter((parent) => parent.sha) ?? [],
        };
    }

    private readonly _prStateMap = new Map<
        RestEndpointMethodTypes['pulls']['get']['response']['data']['state'],
        PullRequestState
    >([
        ['open', PullRequestState.OPENED],
        ['closed', PullRequestState.CLOSED],
    ]);

    private readonly _prStateMapReverse = new Map<
        PullRequestState,
        RestEndpointMethodTypes['pulls']['list']['parameters']['state']
    >([
        [PullRequestState.OPENED, 'open'],
        [PullRequestState.MERGED, 'closed'], // GitHub does not have a separate 'merged' state, so we map it to 'closed'
        [PullRequestState.CLOSED, 'closed'],
        [PullRequestState.ALL, 'all'],
    ]);

    /**
     * Transforms a raw pull request object from the Github API into the standard PullRequest interface.
     * @param pullRequest - The raw pull request data from the Github API.
     * @param organizationAndTeamData - The organization and team context.
     * @returns A PullRequest object.
     */
    private transformPullRequest(
        pullRequest:
            | RestEndpointMethodTypes['pulls']['get']['response']['data']
            | RestEndpointMethodTypes['pulls']['list']['response']['data'][number],
        organizationAndTeamData: OrganizationAndTeamData,
    ): PullRequest {
        return {
            id: pullRequest?.id?.toString() ?? '',
            number: pullRequest?.number ?? -1,
            pull_number: pullRequest?.number ?? -1, // TODO: remove, legacy, use number
            organizationId: organizationAndTeamData?.organizationId ?? '',
            title: pullRequest?.title ?? '',
            body: pullRequest?.body ?? '',
            state:
                this._prStateMap.get(
                    pullRequest?.state as RestEndpointMethodTypes['pulls']['get']['response']['data']['state'],
                ) ?? PullRequestState.ALL,
            prURL: pullRequest?.html_url ?? '',
            repository:
                pullRequest?.base?.repo?.full_name ??
                pullRequest?.base?.repo?.name ??
                '', // TODO: remove, legacy, use repositoryData
            repositoryId: pullRequest?.base?.repo?.id?.toString() ?? '', // TODO: remove, legacy, use repositoryData
            repositoryData: {
                id: pullRequest?.base?.repo?.id?.toString() ?? '',
                name:
                    pullRequest?.base?.repo?.full_name ??
                    pullRequest?.base?.repo?.name ??
                    '',
            },
            message: pullRequest?.title ?? '',
            created_at: pullRequest?.created_at ?? '',
            closed_at: pullRequest?.closed_at ?? '',
            updated_at: pullRequest?.updated_at ?? '',
            merged_at: pullRequest?.merged_at ?? '',
            participants: [
                {
                    id: pullRequest?.user?.id?.toString() ?? '',
                },
            ],
            reviewers:
                pullRequest?.requested_reviewers?.map((r) => ({
                    id: r?.id?.toString() ?? '',
                })) ?? [],
            sourceRefName: pullRequest?.head?.ref ?? '', // TODO: remove, legacy, use head.ref
            head: {
                ref: pullRequest?.head?.ref ?? '',
                repo: {
                    id: pullRequest?.head?.repo?.id?.toString() ?? '',
                    name: pullRequest?.head?.repo?.name ?? '',
                    defaultBranch:
                        pullRequest?.head?.repo?.default_branch ?? '',
                    fullName: pullRequest?.head?.repo?.full_name ?? '',
                },
            },
            targetRefName: pullRequest?.base?.ref ?? '', // TODO: remove, legacy, use base.ref
            base: {
                ref: pullRequest?.base?.ref ?? '',
                repo: {
                    id: pullRequest?.base?.repo?.id?.toString() ?? '',
                    name: pullRequest?.base?.repo?.name ?? '',
                    defaultBranch:
                        pullRequest?.base?.repo?.default_branch ?? '',
                    fullName: pullRequest?.base?.repo?.full_name ?? '',
                },
            },
            user: {
                login: pullRequest?.user?.login ?? '',
                name: pullRequest?.user?.name ?? '',
                id: pullRequest?.user?.id?.toString() ?? '',
            },
            isDraft: pullRequest?.draft ?? false,
        };
    }

    private transformRepositoryFile(
        file: RestEndpointMethodTypes['git']['getTree']['response']['data']['tree'][number],
    ): RepositoryFile {
        return {
            filename: file?.path?.split('/').pop() ?? '',
            sha: file?.sha ?? '',
            size: file?.size ?? -1,
            path: file?.path ?? '',
            type: file?.type ?? 'blob',
        };
    }
}
