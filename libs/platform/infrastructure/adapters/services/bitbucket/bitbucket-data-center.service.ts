import { createLogger } from '@kodus/flow';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { v4 } from 'uuid';

import { decrypt, encrypt } from '@libs/common/utils/crypto';
import {
    CreateAuthIntegrationStatus,
    IntegrationCategory,
    IntegrationConfigKey,
    PlatformType,
    PullRequestState,
} from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { BitbucketAuthDetail } from '@libs/integrations/domain/authIntegrations/types/bitbucket-auth-detail.type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@libs/integrations/domain/integrations/entities/integration.entity';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import {
    CodeManagementConnectionStatus,
    ICodeManagementService,
} from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import {
    PullRequest,
    PullRequestAuthor,
    PullRequestCodeReviewTime,
    PullRequestReviewState,
    PullRequestWithFiles,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repository } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { RepositoryFile } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';

@Injectable()
export class BitbucketDataCenterService implements Omit<
    ICodeManagementService,
    | 'getOrganizations'
    | 'getListOfValidReviews'
    | 'getUserByEmailOrName'
    | 'getPullRequestReviewThreads'
    | 'getUserById'
    | 'getDataForCalculateDeployFrequency'
    | 'getCommitsByReleaseMode'
    | 'getAuthenticationOAuthToken'
    | 'formatCodeBlock'
    | 'getListOfCriticalIssues'
    | 'getCriticalIssuesSummaryArray'
    | 'findTeamAndOrganizationIdByConfigKey'
    | 'countReactions'
    | 'formatReviewCommentBody'
    | 'getWorkflows'
    | 'addReactionToPR'
    | 'addReactionToComment'
    | 'removeReactionsFromPR'
    | 'removeReactionsFromComment'
    | 'minimizeComment'
> {
    private readonly logger = createLogger(BitbucketDataCenterService.name);

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        private readonly configService: ConfigService,
        private readonly mcpManagerService?: MCPManagerService,
    ) {}

    /**
     * Helper to create a pre-configured Axios instance for Bitbucket Data Center
     */
    private getAxiosInstance(authDetails: BitbucketAuthDetail): AxiosInstance {
        if (!authDetails.host) {
            throw new BadRequestException(
                'Host URL is required for Bitbucket Data Center integration.',
            );
        }

        // Clean up host URL to prevent double slashes
        const baseURL = authDetails.host.replace(/\/+$/, '');
        const token = decrypt(authDetails.appPassword);

        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        };

        // Data Center supports Personal Access Tokens (Bearer) or Basic Auth
        if (authDetails.authMode === AuthMode.TOKEN) {
            headers['Authorization'] = `Bearer ${token}`;
        } else {
            const basic = Buffer.from(
                `${authDetails.username}:${token}`,
            ).toString('base64');
            headers['Authorization'] = `Basic ${basic}`;
        }

        return axios.create({
            baseURL: `${baseURL}/rest/api/1.0`,
            headers,
            timeout: 30000,
        });
    }

    async getAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<BitbucketAuthDetail> {
        try {
            const bitbucketAuthDetail =
                await this.integrationService.getPlatformAuthDetails<BitbucketAuthDetail>(
                    organizationAndTeamData,
                    PlatformType.BITBUCKET,
                );

            return {
                ...bitbucketAuthDetail,
                authMode: bitbucketAuthDetail?.authMode || AuthMode.TOKEN,
            };
        } catch (err) {
            this.logger.error({
                message: 'Error getting auth details for Bitbucket Data Center',
                context: BitbucketDataCenterService.name,
                error: err,
                metadata: { organizationAndTeamData },
            });
            throw err;
        }
    }

    async authenticateWithToken(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        token: string;
        username?: string;
        email?: string;
        host?: string;
        authMode?: AuthMode;
    }): Promise<{ success: boolean; status?: CreateAuthIntegrationStatus }> {
        try {
            const {
                organizationAndTeamData,
                token,
                username,
                email,
                host,
                authMode = AuthMode.TOKEN,
            } = params;

            if (!host) {
                throw new BadRequestException(
                    'Host is required for Bitbucket Data Center.',
                );
            }

            const authDetails: BitbucketAuthDetail = {
                username: username || '',
                appPassword: encrypt(token),
                authMode,
                email: email,
                host: host,
            };

            const axiosClient = this.getAxiosInstance(authDetails);

            // Test connection by fetching projects (lightweight endpoint)
            const testResponse = await axiosClient.get('/projects?limit=1');

            if (testResponse.status !== 200) {
                throw new Error(
                    'Bitbucket Data Center failed to validate the provided token.',
                );
            }

            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.BITBUCKET,
            });

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

            return {
                success: true,
                status: CreateAuthIntegrationStatus.SUCCESS,
            };
        } catch (err) {
            this.logger.error({
                message: 'Error authenticating with Data Center token',
                context: BitbucketDataCenterService.name,
                error: err,
                metadata: { params },
            });
            throw new BadRequestException(
                'Error authenticating with Bitbucket Data Center.',
            );
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
                platform: PlatformType.BITBUCKET,
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
                context: BitbucketDataCenterService.name,
                serviceName:
                    'BitbucketDataCenterService findOneByOrganizationAndTeamDataAndConfigKey',
                error: err,
                metadata: {
                    organizationAndTeamData,
                    configKey,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async verifyConnection(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<CodeManagementConnectionStatus> {
        try {
            const { organizationAndTeamData } = params;

            if (!organizationAndTeamData.organizationId) {
                return {
                    platformName: PlatformType.BITBUCKET,
                    isSetupComplete: false,
                    hasConnection: false,
                    config: {},
                };
            }

            const bitbucketOrg = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                status: true,
                platform: PlatformType.BITBUCKET,
            });

            const bitbucketRepositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            const hasRepositories =
                bitbucketRepositories?.configValue?.length > 0;
            const hasAuthDetails =
                !!bitbucketOrg?.authIntegration?.authDetails?.appPassword;

            return {
                platformName: PlatformType.BITBUCKET,
                isSetupComplete: hasRepositories && hasAuthDetails,
                hasConnection: !!bitbucketOrg,
                config: {
                    hasRepositories: hasRepositories,
                    status: bitbucketRepositories?.installationStatus,
                },
                category: IntegrationCategory.CODE_MANAGEMENT,
            };
        } catch (err) {
            this.logger.error({
                message: 'Error verifying Data Center connection',
                context: BitbucketDataCenterService.name,
                error: err,
                metadata: { params },
            });
            throw new BadRequestException(err);
        }
    }

    async getRepositories(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<Repositories[]> {
        try {
            const { organizationAndTeamData } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetails) return [];

            const axiosClient = this.getAxiosInstance(authDetails);

            // Fetch repositories across all projects
            // Note: In DC, 'repos' returns repositories the user has permission to see across projects
            const response = await axiosClient.get('/repos?limit=1000');
            const dataCenterRepos = response.data.values || [];

            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.BITBUCKET,
            });

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: organizationAndTeamData.teamId },
                });

            return dataCenterRepos.map((repo: any): Repositories => {
                const cloneUrl =
                    repo.links?.clone?.find((link: any) => link.name === 'http')
                        ?.href || '';

                return {
                    id: repo.id.toString(), // DC uses numeric IDs
                    name: repo.slug ?? repo.name,
                    http_url: cloneUrl,
                    avatar_url: '', // Bitbucket DC typically handles avatars differently
                    organizationName: repo.project.key,
                    visibility: repo.public ? 'public' : 'private',
                    selected:
                        integrationConfig?.configValue?.some(
                            (r: any) =>
                                r?.name === repo.slug || r?.name === repo.name,
                        ) ?? false,
                    default_branch: 'master', // Requires separate call to /branches/default to get reliably in DC
                    workspaceId: repo.project.key, // We map Project Key -> Workspace ID for continuity
                    project: {
                        id: repo.project.id.toString(),
                        name: repo.project.name ?? '',
                    },
                    lastActivityAt: undefined, // Requires separate calls in DC
                };
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting repositories from Bitbucket Data Center',
                context: BitbucketDataCenterService.name,
                error,
                metadata: { params },
            });
            throw new BadRequestException(error);
        }
    }

    async updateAuthIntegration(params: any): Promise<any> {
        await this.integrationService.update(
            { uuid: params.integrationId },
            { status: true },
        );

        return await this.authIntegrationService.update(
            { uuid: params.authIntegrationId },
            {
                status: true,
                authDetails: params?.authDetails,
            },
        );
    }

    async addAccessToken(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails: BitbucketAuthDetail,
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
            platform: PlatformType.BITBUCKET,
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            authIntegration: { uuid: authIntegrationId },
        });
    }

    async getPullRequests(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { id: string; name: string };
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
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return [];

            const axiosClient = this.getAxiosInstance(authDetails);

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            let reposToProcess = allRepositories;
            if (repository?.name || repository?.id) {
                reposToProcess = allRepositories.filter(
                    (r) => r.name === repository.name || r.id === repository.id,
                );
            }

            const pullRequests: PullRequest[] = [];

            // Map standard states to Data Center states
            let stateFilter = 'ALL';
            if (filters.state === PullRequestState.OPENED) stateFilter = 'OPEN';
            if (filters.state === PullRequestState.MERGED)
                stateFilter = 'MERGED';
            if (filters.state === PullRequestState.CLOSED)
                stateFilter = 'DECLINED';

            for (const repo of reposToProcess) {
                const projectKey = repo.workspaceId; // Mapped in getRepositories
                const repoSlug = repo.name;

                let isLastPage = false;
                let start = 0;

                while (!isLastPage) {
                    const response = await axiosClient.get(
                        `/projects/${projectKey}/repos/${repoSlug}/pull-requests`,
                        {
                            params: {
                                state: stateFilter,
                                limit: 100,
                                start: start,
                                order: 'NEWEST',
                            },
                        },
                    );

                    const data = response.data;
                    const prs = data.values || [];

                    for (const pr of prs) {
                        // Apply in-memory filters (dates, author)
                        const createdDate = new Date(pr.createdDate);
                        let isValid = true;

                        if (
                            filters.startDate &&
                            createdDate < filters.startDate
                        )
                            isValid = false;
                        if (filters.endDate && createdDate > filters.endDate)
                            isValid = false;
                        if (
                            filters.author &&
                            pr.author?.user?.displayName !== filters.author
                        )
                            isValid = false;
                        if (
                            filters.branch &&
                            pr.toRef?.displayId !== filters.branch
                        )
                            isValid = false;

                        if (isValid) {
                            pullRequests.push(
                                this.transformDataCenterPR(
                                    pr,
                                    organizationAndTeamData,
                                    repo,
                                ),
                            );
                        }
                    }

                    isLastPage = data.isLastPage;
                    start = data.nextPageStart;
                }
            }

            return pullRequests;
        } catch (error) {
            this.logger.error({
                message:
                    'Error fetching pull requests from Bitbucket Data Center',
                context: BitbucketDataCenterService.name,
                error,
                metadata: { params },
            });
            return [];
        }
    }

    async getPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequest | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetails || !repository.id) return null;

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) => r.id === repository.id || r.name === repository.name,
            );
            if (!repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);
            const projectKey = repoConfig.workspaceId;
            const repoSlug = repoConfig.name;

            const response = await axiosClient.get(
                `/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prNumber}`,
            );

            return this.transformDataCenterPR(
                response.data,
                organizationAndTeamData,
                repoConfig,
            );
        } catch (error) {
            this.logger.error({
                message: `Error getting pull request #${params.prNumber} from Data Center`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
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
    }) {
        const { organizationAndTeamData, repository, filters = {} } = params;

        try {
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return [];

            const axiosClient = this.getAxiosInstance(authDetails);

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            let reposToProcess = allRepositories;
            if (repository?.name) {
                reposToProcess = allRepositories.filter(
                    (r) => r.name === repository.name,
                );
            }

            const commits = [];

            for (const repo of reposToProcess) {
                const projectKey = repo.workspaceId;
                const repoSlug = repo.name;

                const response = await axiosClient.get(
                    `/projects/${projectKey}/repos/${repoSlug}/commits`,
                    {
                        params: {
                            until: filters.branch, // 'until' is the branch/ref in DC
                            limit: 100,
                        },
                    },
                );

                const rawCommits = response.data?.values || [];

                for (const rawCommit of rawCommits) {
                    let isValid = true;
                    const commitDate = new Date(rawCommit.authorTimestamp);

                    if (filters.startDate && commitDate < filters.startDate)
                        isValid = false;
                    if (filters.endDate && commitDate > filters.endDate)
                        isValid = false;
                    if (
                        filters.author &&
                        rawCommit.author?.name !== filters.author
                    )
                        isValid = false;

                    if (isValid) {
                        commits.push({
                            sha: rawCommit.id,
                            commit: {
                                author: {
                                    id:
                                        rawCommit.author?.emailAddress ||
                                        rawCommit.author?.name, // DC doesn't guarantee UUIDs for authors
                                    name:
                                        rawCommit.author?.displayName ||
                                        rawCommit.author?.name,
                                    email: rawCommit.author?.emailAddress || '',
                                    date: commitDate.toISOString(),
                                },
                                message: rawCommit.message,
                            },
                            parents:
                                rawCommit.parents?.map((p: any) => ({
                                    sha: p.id,
                                })) || [],
                        });
                    }
                }
            }

            return commits;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching commits from Bitbucket Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return [];
        }
    }

    async getCloneParams(params: {
        repository: Pick<
            Repository,
            'id' | 'defaultBranch' | 'fullName' | 'name'
        >;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any> {
        try {
            const authDetails = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetails)
                throw new BadRequestException('Installation not found');

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: params.organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) =>
                    r.id === params.repository.id ||
                    r.name === params.repository.name,
            );
            const projectKey =
                repoConfig?.workspaceId ||
                params.repository.fullName?.split('/')[0];

            // Clean host URL and construct clone URL for Data Center
            const baseURL = authDetails.host?.replace(/\/+$/, '') || '';
            const cloneUrl = `${baseURL}/scm/${projectKey?.toLowerCase()}/${params.repository.name?.toLowerCase()}.git`;

            return {
                organizationId: params?.organizationAndTeamData?.organizationId,
                repositoryId: params?.repository?.id,
                repositoryName: params?.repository?.name,
                url: cloneUrl,
                branch: params?.repository?.defaultBranch || 'master',
                provider: PlatformType.BITBUCKET,
                auth: {
                    username: authDetails.username,
                    type: authDetails.authMode,
                    token: decrypt(authDetails.appPassword),
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Failed to generate clone params for Data Center',
                context: BitbucketDataCenterService.name,
                error: error.message,
                metadata: params,
            });
            return null;
        }
    }

    private transformDataCenterPR(
        pr: any,
        organizationAndTeamData: OrganizationAndTeamData,
        repoConfig: Repositories,
    ): PullRequest {
        let state = PullRequestState.ALL;
        if (pr.state === 'OPEN') state = PullRequestState.OPENED;
        if (pr.state === 'MERGED') state = PullRequestState.MERGED;
        if (pr.state === 'DECLINED') state = PullRequestState.CLOSED;

        return {
            id: pr.id.toString(),
            number: pr.id,
            pull_number: pr.id,
            organizationId: organizationAndTeamData.organizationId,
            title: pr.title || '',
            body: pr.description || '',
            state: state,
            prURL: pr.links?.self?.[0]?.href || '',
            repository: repoConfig.name,
            repositoryId: repoConfig.id,
            repositoryData: {
                id: repoConfig.id,
                name: repoConfig.name,
            },
            message: pr.title || '',
            created_at: new Date(pr.createdDate).toISOString(),
            updated_at: new Date(pr.updatedDate).toISOString(),
            closed_at: pr.closedDate
                ? new Date(pr.closedDate).toISOString()
                : '',
            merged_at:
                pr.state === 'MERGED'
                    ? new Date(pr.updatedDate).toISOString()
                    : '',
            participants:
                pr.participants?.map((p: any) => ({
                    id: p.user?.name || '',
                })) || [],
            reviewers:
                pr.reviewers?.map((r: any) => ({ id: r.user?.name || '' })) ||
                [],
            sourceRefName: pr.fromRef?.displayId || '',
            head: {
                ref: pr.fromRef?.displayId || '',
                repo: {
                    id: pr.fromRef?.repository?.id?.toString() || '',
                    name: pr.fromRef?.repository?.slug || '',
                    defaultBranch: 'master',
                    fullName: `${pr.fromRef?.repository?.project?.key}/${pr.fromRef?.repository?.slug}`,
                },
            },
            targetRefName: pr.toRef?.displayId || '',
            base: {
                ref: pr.toRef?.displayId || '',
                repo: {
                    id: pr.toRef?.repository?.id?.toString() || '',
                    name: pr.toRef?.repository?.slug || '',
                    defaultBranch: 'master',
                    fullName: `${pr.toRef?.repository?.project?.key}/${pr.toRef?.repository?.slug}`,
                },
            },
            user: {
                login: pr.author?.user?.name || '',
                name: pr.author?.user?.displayName || '',
                id: pr.author?.user?.name || '', // Using username as ID since DC doesn't guarantee UUIDs
            },
            isDraft:
                pr.title?.toLowerCase().startsWith('wip:') ||
                pr.title?.toLowerCase().startsWith('[draft]'),
        };
    }

    async createWebhook(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        try {
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return;

            const axiosClient = this.getAxiosInstance(authDetails);
            const repositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const webhookUrl =
                this.configService.get<string>(
                    'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
                ) ?? process.env.GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK;

            if (!webhookUrl) {
                this.logger.warn({
                    message: 'No Webhook URL configured in environment.',
                    context: BitbucketDataCenterService.name,
                    metadata: { organizationAndTeamData },
                });
                return;
            }

            for (const repo of repositories) {
                const projectKey = repo.workspaceId;
                const repoSlug = repo.name;

                // 1. Check existing webhooks
                const existingHooksRes = await axiosClient.get(
                    `/projects/${projectKey}/repos/${repoSlug}/webhooks`,
                );
                const existingHooks = existingHooksRes.data.values || [];
                const hookExists = existingHooks.some(
                    (hook: any) => hook.url === webhookUrl,
                );

                // 2. Create if it doesn't exist
                if (!hookExists) {
                    await axiosClient.post(
                        `/projects/${projectKey}/repos/${repoSlug}/webhooks`,
                        {
                            name: 'Kodus Webhook',
                            url: webhookUrl,
                            active: true,
                            events: [
                                'pr:opened',
                                'pr:modified',
                                'pr:reviewer:updated',
                                'pr:comment:added',
                                'pr:merged',
                                'pr:declined',
                            ],
                        },
                    );

                    this.logger.log({
                        message: `Webhook created successfully for DC repo ${repoSlug}`,
                        context: BitbucketDataCenterService.name,
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error creating webhook in Bitbucket Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            throw error;
        }
    }

    async isWebhookActive(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<boolean> {
        try {
            const { organizationAndTeamData, repositoryId } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return false;

            const repositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const targetRepo = repositories.find((r) => r.id === repositoryId);
            if (!targetRepo) return false;

            const webhookUrl =
                this.configService.get<string>(
                    'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
                ) ?? process.env.GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK;

            const axiosClient = this.getAxiosInstance(authDetails);
            const response = await axiosClient.get(
                `/projects/${targetRepo.workspaceId}/repos/${targetRepo.name}/webhooks`,
            );

            return (
                response.data.values?.some(
                    (hook: any) => hook.url === webhookUrl && hook.active,
                ) ?? false
            );
        } catch (error) {
            this.logger.error({
                message: 'Error checking webhook status in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return false;
        }
    }

    async createCommentInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
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
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return null;

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) => r.id === repository.id || r.name === repository.name,
            );
            if (!repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            const response = await axiosClient.post(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/comments`,
                { text: overallComment },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: `Error creating global comment on DC PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async mergePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }) {
        try {
            const { organizationAndTeamData, prNumber, repository } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return null;

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) => r.id === repository.id,
            );
            if (!repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);
            const prPath = `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}`;

            // Bitbucket DC requires the current PR version to merge
            const prRes = await axiosClient.get(prPath);
            const prVersion = prRes.data.version;

            await axiosClient.post(`${prPath}/merge`, null, {
                params: { version: prVersion },
            });

            this.logger.log({
                message: `Merged DC pull request #${prNumber}`,
                context: BitbucketDataCenterService.name,
            });
        } catch (error) {
            this.logger.error({
                message: `Error merging DC PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async approvePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }) {
        try {
            const { organizationAndTeamData, prNumber, repository } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return null;

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) => r.id === repository.id,
            );
            if (!repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            await axiosClient.put(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/participants/${authDetails.username}`,
                {
                    status: 'APPROVED',
                },
            );
        } catch (error) {
            this.logger.error({
                message: `Error approving DC pull request #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getFilesByPullRequestId(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<any[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return null;

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) => r.id === repository.id,
            );
            if (!repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // 1. Fetch the PR to get the latest source commit hash (fromRef)
            const prResponse = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}`,
            );
            const sourceCommit =
                prResponse.data?.fromRef?.latestCommit ||
                prResponse.data?.fromRef?.id;

            // 2. Fetch the list of changed files
            const changesResponse = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/changes`,
                { params: { limit: 1000 } },
            );

            const files = changesResponse.data.values || [];

            // 3. Map through files in parallel to fetch raw content and reconstruct the diff patch
            const prFilesWithDiffAndContents = await Promise.all(
                files.map(async (file: any) => {
                    const filePath = file.path.toString;
                    const isRemoved =
                        file.type === 'DELETE' || file.type === 'REMOVED';

                    let content = null;
                    let patch = '';
                    let additions = 0;
                    let deletions = 0;

                    // Fetch Raw Content (Skip if the file was deleted)
                    if (!isRemoved && sourceCommit) {
                        try {
                            const rawRes = await axiosClient.get(
                                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/raw/${filePath}`,
                                {
                                    params: { at: sourceCommit },
                                    responseType: 'text',
                                },
                            );
                            content = rawRes.data;
                        } catch (err) {
                            this.logger.error({
                                message: `Could not fetch raw content for ${filePath} at commit ${sourceCommit}`,
                                context: BitbucketDataCenterService.name,
                                metadata: { filePath, sourceCommit },
                                error: err,
                            });
                        }
                    }

                    // Fetch JSON Diff and Reconstruct Unified Patch String
                    try {
                        const diffRes = await axiosClient.get(
                            `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/diff`,
                            {
                                params: { path: filePath, limit: 1000 },
                            },
                        );

                        const diffs = diffRes.data.diffs || [];

                        for (const diff of diffs) {
                            const hunks = diff.hunks || [];

                            for (const hunk of hunks) {
                                // Construct standard Unified Diff hunk header
                                patch += `@@ -${hunk.sourceLine || 0},${hunk.sourceSpan || 0} +${hunk.destinationLine || 0},${hunk.destinationSpan || 0} @@\n`;

                                const segments = hunk.segments || [];
                                for (const segment of segments) {
                                    const prefix =
                                        segment.type === 'ADDED'
                                            ? '+'
                                            : segment.type === 'REMOVED'
                                              ? '-'
                                              : ' ';

                                    if (segment.type === 'ADDED')
                                        additions += segment.lines?.length || 0;
                                    if (segment.type === 'REMOVED')
                                        deletions += segment.lines?.length || 0;

                                    for (const line of segment.lines || []) {
                                        patch += `${prefix}${line.line}\n`;
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        this.logger.error({
                            message: `Could not fetch diff for ${filePath}`,
                            context: BitbucketDataCenterService.name,
                            metadata: { filePath, prNumber },
                            error: err,
                        });
                    }

                    return {
                        filename: filePath,
                        sha: sourceCommit,
                        status:
                            file.type === 'MODIFY'
                                ? 'modified'
                                : file.type === 'ADD'
                                  ? 'added'
                                  : 'removed',
                        additions,
                        deletions,
                        changes: additions + deletions,
                        patch: patch || null,
                        content: content,
                        blob_url: null,
                        contents_url: null,
                        raw_url: null,
                    };
                }),
            );

            return prFilesWithDiffAndContents;
        } catch (error) {
            this.logger.error({
                message: `Error getting fully populated files for DC PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async uploadFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        branchName?: string;
        baseBranch?: string;
        files: any[];
        message?: string;
        author?: { name: string; email?: string };
    }): Promise<boolean> {
        const {
            organizationAndTeamData,
            repository,
            branchName,
            baseBranch,
            files,
            message,
        } = params;

        try {
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return false;

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) => r.id === repository.id,
            );
            if (!repoConfig) return false;

            const axiosClient = this.getAxiosInstance(authDetails);
            const projectKey = repoConfig.workspaceId;
            const repoSlug = repoConfig.name;

            const resolvedBranchName = branchName || baseBranch || 'master';
            const resolvedMessage = message || 'Automated commit';

            // 1. Create the branch if it doesn't exist (assuming baseBranch is provided and differs)
            if (resolvedBranchName !== baseBranch) {
                try {
                    // Check if branch exists
                    await axiosClient.get(
                        `/projects/${projectKey}/repos/${repoSlug}/branches/default`,
                    );

                    // Note: Branch creation in DC: POST /rest/api/1.0/projects/{prj}/repos/{repo}/branches
                    await axiosClient.post(
                        `/projects/${projectKey}/repos/${repoSlug}/branches`,
                        {
                            name: resolvedBranchName,
                            startPoint: baseBranch || 'master',
                        },
                    );
                } catch (err) {
                    // Branch might already exist, which is fine.
                }
            }

            // 2. Upload files sequentially
            // Bitbucket DC requires PUT requests to /browse/{path} for file creation/updates
            for (const file of files) {
                const operation = file.operation || 'upsert';
                const filePath = file.path.startsWith('/')
                    ? file.path.substring(1)
                    : file.path;

                const form = new FormData();
                form.append('branch', resolvedBranchName);
                form.append('message', resolvedMessage);

                if (operation === 'delete') {
                    // DELETE /rest/api/1.0/projects/{prj}/repos/{repo}/browse/{path} doesn't exist in the same way.
                    // Usually you POST to /rest/api/1.0/projects/{prj}/repos/{repo}/commits or use a specific plugin.
                    // For pure REST, file deletion is tricky without a local git clone.
                    this.logger.warn({
                        message:
                            'File deletion via REST API in Data Center requires multipart form tricks or local git manipulation.',
                        context: BitbucketDataCenterService.name,
                        metadata: { filePath, operation, repository: repoSlug },
                    });
                    continue;
                }

                if (typeof file.content !== 'string') continue;

                form.append('content', file.content);

                // Note: The axios client needs specific headers for multipart/form-data here
                await axiosClient.put(
                    `/projects/${projectKey}/repos/${repoSlug}/browse/${filePath}`,
                    form,
                    { headers: { 'Content-Type': 'multipart/form-data' } },
                );
            }

            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error uploading files to Bitbucket Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return false;
        }
    }

    async createPullRequestWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        sourceBranch?: string;
        targetBranch?: string;
        baseBranch?: string;
        title?: string;
        description?: string;
        commitMessage?: string;
        author?: { name: string; email?: string };
        files: any[];
    }): Promise<Partial<PullRequest> | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                sourceBranch,
                targetBranch,
                title,
                description,
                files,
                commitMessage,
                author,
            } = params;

            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return null;

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) => r.id === repository.id,
            );
            if (!repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);
            const projectKey = repoConfig.workspaceId;
            const repoSlug = repoConfig.name;

            const resolvedSourceBranch =
                sourceBranch || `kody-auto-${Date.now()}`;
            const resolvedTargetBranch = targetBranch || 'master';

            // 1. Upload the files sequentially to the source branch
            const uploadSuccess = await this.uploadFiles({
                organizationAndTeamData,
                repository,
                branchName: resolvedSourceBranch,
                baseBranch: resolvedTargetBranch,
                files,
                message: commitMessage,
                author,
            });

            if (!uploadSuccess)
                throw new BadRequestException(
                    'Failed to upload files to Data Center.',
                );

            // 2. Create the Pull Request
            const response = await axiosClient.post(
                `/projects/${projectKey}/repos/${repoSlug}/pull-requests`,
                {
                    title: title || 'Automated Pull Request',
                    description: description || '',
                    state: 'OPEN',
                    open: true,
                    closed: false,
                    fromRef: {
                        id: `refs/heads/${resolvedSourceBranch}`,
                        repository: {
                            slug: repoSlug,
                            project: { key: projectKey },
                        },
                    },
                    toRef: {
                        id: `refs/heads/${resolvedTargetBranch}`,
                        repository: {
                            slug: repoSlug,
                            project: { key: projectKey },
                        },
                    },
                },
            );

            return {
                id: response.data.id.toString(),
                number: response.data.id,
                title: response.data.title,
                prURL: response.data.links?.self?.[0]?.href || '',
            };
        } catch (error) {
            this.logger.error({
                message:
                    'Error creating pull request with files in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        treeType?: 'all' | 'directories' | 'files';
    }): Promise<any[]> {
        try {
            const {
                organizationAndTeamData,
                repositoryId,
                treeType = 'all',
            } = params;

            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return [];

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const targetRepo = allRepositories.find(
                (r) => r.id === repositoryId,
            );
            if (!targetRepo) return [];

            const axiosClient = this.getAxiosInstance(authDetails);

            // In DC, we use the /files endpoint to get a flat list of all files, or /browse for directories
            const response = await axiosClient.get(
                `/projects/${targetRepo.workspaceId}/repos/${targetRepo.name}/files`,
                { params: { limit: 100000 } },
            );

            const files = response.data.values || [];

            return files
                .map((filePath: string) => {
                    const isDir = filePath.endsWith('/');
                    if (treeType === 'directories' && !isDir) return null;
                    if (treeType === 'files' && isDir) return null;

                    return {
                        path: filePath,
                        type: isDir ? 'directory' : 'file',
                        sha: '', // Not provided directly in the flat list
                        url: '',
                        hasChildren: isDir,
                    };
                })
                .filter(Boolean);
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting repository tree from Bitbucket Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return [];
        }
    }

    async createReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: any;
        prNumber: number;
        lineComment: any;
        commit: any;
        language: string;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                lineComment,
            } = params;

            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return null;

            const allRepositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const repoConfig = allRepositories.find(
                (r) => r.id === repository.id,
            );
            if (!repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // Formatting logic stripped for brevity, assuming raw string
            const commentBody =
                lineComment?.body?.suggestionContent || 'Suggested changes.';

            // Data Center specific payload for inline PR comments
            const payload = {
                text: commentBody,
                severity: 'NORMAL',
                anchor: {
                    line: lineComment.line || lineComment.start_line,
                    lineType: 'ADDED', // or CONTEXT, REMOVED depending on the diff
                    fileType: 'TO',
                    path: lineComment.path,
                    diffType: 'EFFECTIVE',
                },
            };

            const response = await axiosClient.post(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/comments`,
                payload,
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error creating inline review comment in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    private async getRepoConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryIdOrName: string,
    ): Promise<Repositories | null> {
        const allRepositories = <Repositories[]>(
                await this.integrationConfigService.findOne({
                    team: { uuid: organizationAndTeamData.teamId },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                })
            )?.configValue || [];

        return (
            allRepositories.find(
                (r) =>
                    r.id === repositoryIdOrName ||
                    r.name === repositoryIdOrName,
            ) || null
        );
    }

    async findRepositoryByName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        name: string;
    }) {
        try {
            const { organizationAndTeamData, name } = params;
            const repositories = await this.getRepositories({
                organizationAndTeamData,
            });

            const wanted = name.trim().toLowerCase();
            const repository = repositories.find(
                (repo) =>
                    repo.name.toLowerCase() === wanted ||
                    `${repo.organizationName}/${repo.name}`.toLowerCase() ===
                        wanted,
            );

            if (!repository) return null;

            return {
                id: repository.id,
                name: repository.name,
                fullName: `${repository.organizationName}/${repository.name}`,
                url: repository.http_url,
                organizationName: repository.organizationName,
                defaultBranch: repository.default_branch,
                visibility: repository.visibility,
                workspaceId: repository.workspaceId,
                project: repository.project,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error finding repository by name in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getDefaultBranch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<string> {
        try {
            const { organizationAndTeamData, repository } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return 'master';

            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );
            if (!repoConfig) return 'master';

            const axiosClient = this.getAxiosInstance(authDetails);

            const response = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/branches/default`,
            );

            return response.data?.displayId || 'master';
        } catch (error) {
            this.logger.error({
                message: 'Error getting default branch from Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return 'master'; // Fallback
        }
    }

    async getLanguageRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<any | null> {
        // Note: Bitbucket Data Center does not expose a native repository language endpoint
        // in its standard REST API 1.0 unlike Bitbucket Cloud.
        this.logger.debug({
            message:
                'getLanguageRepository is not natively supported in Bitbucket Data Center REST API',
            context: BitbucketDataCenterService.name,
            metadata: { params },
        });
        return null;
    }

    async getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null> {
        try {
            const authDetails = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetails) return null;

            // DC does not have an exact equivalent to Cloud's /user, but we can query the users
            // endpoint for the currently authenticated username.
            const axiosClient = this.getAxiosInstance(authDetails);
            const response = await axiosClient.get('/users', {
                params: { filter: authDetails.username, limit: 1 },
            });

            const user = response.data?.values?.[0];

            if (!user) {
                // Fallback to basic auth details if endpoint fails or doesn't match
                return {
                    id: authDetails.username,
                    uuid: authDetails.username,
                    login: authDetails.username,
                    name: authDetails.username,
                };
            }

            return {
                id: user.name, // DC relies heavily on the 'name' (username) as the identifier
                uuid: user.name,
                login: user.name,
                name: user.displayName,
                email: user.emailAddress,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving current user in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any | null> {
        try {
            const authDetails = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetails) return null;

            const axiosClient = this.getAxiosInstance(authDetails);
            const response = await axiosClient.get('/users', {
                params: { filter: params.username, limit: 1 },
            });

            const user = response.data?.values?.[0];
            if (!user) return null;

            return {
                id: user.name,
                uuid: user.name,
                login: user.name,
                name: user.displayName,
                email: user.emailAddress,
            };
        } catch (error) {
            this.logger.error({
                message: `Error retrieving user ${params.username} in Data Center`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getListMembers(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<{ name: string; id: string | number }[]> {
        try {
            const { organizationAndTeamData } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return [];

            const repositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            if (!repositories.length) return [];

            const axiosClient = this.getAxiosInstance(authDetails);
            const uniqueMembers = new Map<
                string,
                { name: string; id: string; type: string }
            >();

            // Collect unique project keys (Workspaces)
            const projectKeys = Array.from(
                new Set(repositories.map((r) => r.workspaceId).filter(Boolean)),
            );

            for (const projectKey of projectKeys) {
                let isLastPage = false;
                let start = 0;

                // Fetch users with explicit permission granted to the project
                while (!isLastPage) {
                    const response = await axiosClient.get(
                        `/projects/${projectKey}/permissions/users`,
                        {
                            params: { limit: 100, start },
                        },
                    );

                    const users = response.data.values || [];

                    for (const permission of users) {
                        const user = permission.user;
                        if (!user || uniqueMembers.has(user.name)) continue;

                        uniqueMembers.set(user.name, {
                            id: user.name, // Username is the primary ID in DC
                            name: user.displayName || user.name,
                            type: 'user',
                        });
                    }

                    isLastPage = response.data.isLastPage;
                    start = response.data.nextPageStart;
                }
            }

            return Array.from(uniqueMembers.values());
        } catch (error) {
            this.logger.error({
                message: 'Error getting list of members from Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return [];
        }
    }

    async getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        determineBots?: boolean;
    }): Promise<PullRequestAuthor[]> {
        try {
            const { organizationAndTeamData } = params;

            // We use the existing PR fetching logic, filtered to a recent window
            const startDate = new Date();
            const endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() - 60);

            // In a highly optimized flow, we might directly query the DB,
            // but fetching recent PRs guarantees current API state.
            const pullRequests = await this.getPullRequests({
                organizationAndTeamData,
                filters: {
                    startDate: endDate,
                    endDate: startDate,
                },
            });

            const authorsMap = new Map<string, PullRequestAuthor>();

            for (const pr of pullRequests) {
                const authorId = pr.user.id || pr.user.login;
                if (!authorId || authorsMap.has(authorId)) continue;

                authorsMap.set(authorId, {
                    id: authorId,
                    name: pr.user.name || authorId,
                    type: 'user',
                });
            }

            return Array.from(authorsMap.values()).sort((a, b) =>
                a.name.localeCompare(b.name),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull request authors in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return [];
        }
    }

    async getPullRequestsWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: any;
    }): Promise<PullRequestWithFiles[] | null> {
        try {
            const { organizationAndTeamData, filters = {} } = params;

            // Map the generic state to DC state
            let prState = 'OPEN';
            if (filters.prStatus) {
                const statusStr = filters.prStatus.toLowerCase();
                if (statusStr === 'merged') prState = 'MERGED';
                if (statusStr === 'closed' || statusStr === 'declined')
                    prState = 'DECLINED';
            }

            const rawPrs = await this.getPullRequests({
                organizationAndTeamData,
                repository: filters.repositoryId
                    ? { id: String(filters.repositoryId), name: '' }
                    : undefined,
                filters: {
                    state: prState as PullRequestState,
                    startDate: filters.period?.startDate,
                    endDate: filters.period?.endDate,
                },
            });

            if (!rawPrs || rawPrs.length === 0) return [];

            // Apply limits if requested
            const limit = Math.min(Math.max(filters.limit || 5, 1), 20);
            const prsToProcess = rawPrs.slice(0, limit);

            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return null;
            const axiosClient = this.getAxiosInstance(authDetails);

            const prsWithFiles: PullRequestWithFiles[] = [];

            for (const pr of prsToProcess) {
                const repoConfig = await this.getRepoConfig(
                    organizationAndTeamData,
                    pr.repositoryId,
                );
                if (!repoConfig) continue;

                let pullRequestFiles: any[] = [];

                if (!filters.skipFiles) {
                    // Fetch changes for this specific PR
                    const response = await axiosClient.get(
                        `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${pr.number}/changes`,
                        { params: { limit: 100 } },
                    );

                    const changes = response.data.values || [];
                    pullRequestFiles = changes.map((change: any) => ({
                        additions: 0, // DC doesn't give line counts directly in the changes endpoint without hitting diffs
                        deletions: 0,
                        changes: 0,
                        status: change.type.toLowerCase(),
                    }));
                }

                prsWithFiles.push({
                    id: pr.id as any,
                    pull_number: pr.number,
                    state: pr.state,
                    title: pr.title,
                    repository: {
                        id: repoConfig.id,
                        name: repoConfig.name,
                    },
                    pullRequestFiles,
                });
            }

            return prsWithFiles;
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting pull requests with files in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getCommitsForPullRequestForCodeReview(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<any[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);
            const response = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/commits`,
                { params: { limit: 1000 } },
            );

            const commits = response.data.values || [];

            return commits
                .map((commit: any) => ({
                    sha: commit.id,
                    message: commit.message,
                    created_at: new Date(commit.authorTimestamp).toISOString(),
                    author: {
                        id: commit.author?.emailAddress || commit.author?.name,
                        username: commit.author?.name,
                        name: commit.author?.displayName || commit.author?.name,
                        email: commit.author?.emailAddress,
                        date: new Date(commit.authorTimestamp).toISOString(),
                    },
                    parents:
                        commit.parents?.map((p: any) => ({ sha: p.id })) || [],
                }))
                .sort(
                    (a, b) =>
                        new Date(a.created_at).getTime() -
                        new Date(b.created_at).getTime(),
                );
        } catch (error) {
            this.logger.error({
                message: `Error getting commits for PR #${params.prNumber} in Data Center`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // In Data Center, activities endpoint contains comments, resolutions, approvals, etc.
            const response = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/activities`,
                { params: { limit: 1000 } },
            );

            const activities = response.data.values || [];

            // Filter out only activities that are comments (action === 'COMMENTED')
            const commentActivities = activities.filter(
                (act: any) => act.action === 'COMMENTED' && act.comment,
            );

            return commentActivities
                .map((act: any) => {
                    const comment = act.comment;
                    return {
                        id: comment.id,
                        threadId: comment.thread?.id || comment.id,
                        body: comment.text,
                        createdAt: new Date(comment.createdDate).toISOString(),
                        updatedAt: new Date(comment.updatedDate).toISOString(),
                        isResolved: comment.state === 'RESOLVED',
                        author: {
                            id: comment.author?.name || '',
                            username: comment.author?.name || '',
                            name: comment.author?.displayName || '',
                        },
                    };
                })
                .sort(
                    (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                );
        } catch (error) {
            this.logger.error({
                message: `Error getting review comments for PR #${params.prNumber} in Data Center`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getAllCommentsInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<any[]> {
        const comments = await this.getPullRequestReviewComments(params);
        return comments || [];
    }

    async getPullRequestReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: any;
    }): Promise<any | null> {
        return this.getPullRequestReviewComments({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.filters.repository,
            prNumber: params.filters.pullRequestNumber,
        });
    }

    // --- ALIASES FOR COMMENT CREATION ---
    async createIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        body: any;
    }): Promise<any | null> {
        return this.createCommentInPullRequest({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            prNumber: params.prNumber,
            overallComment: params.body,
        });
    }

    async createSingleIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        body: string;
    }): Promise<any | null> {
        return this.createCommentInPullRequest({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            prNumber: params.prNumber,
            overallComment: params.body,
        });
    }

    async createResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        prNumber: number;
        body: any;
        inReplyToId: number;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                body,
                inReplyToId,
            } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // To reply to a comment in DC, provide the parent id in the payload
            const response = await axiosClient.post(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/comments`,
                {
                    text: body,
                    parent: { id: inReplyToId },
                },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: `Error replying to comment ${params.inReplyToId} on PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async updateIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        commentId: number;
        body: any;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                commentId,
                body,
            } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // We must fetch the comment first to get its current version
            const commentRes = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/comments/${commentId}`,
            );

            const version = commentRes.data.version;

            const response = await axiosClient.put(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/comments/${commentId}`,
                {
                    text: body,
                    version: version,
                },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: `Error updating comment ${params.commentId} on PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        parentId?: string;
        commentId: string;
        body: string;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any | null> {
        // In Bitbucket Data Center, updating a reply is identical to updating a root comment.
        return this.updateIssueComment({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: {
                id: params.repository.id!,
                name: params.repository.name!,
            },
            prNumber: params.prNumber,
            commentId: Number(params.commentId),
            body: params.body,
        });
    }

    async updateDescriptionInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: any;
        prNumber: number;
        summary: any;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, summary } =
                params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);
            const prPath = `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}`;

            // Must fetch PR to get the current version and title (as PUT overwrites payload)
            const prRes = await axiosClient.get(prPath);
            const prData = prRes.data;

            const response = await axiosClient.put(prPath, {
                title: prData.title,
                description: summary,
                version: prData.version,
            });

            return response.data;
        } catch (error) {
            this.logger.error({
                message: `Error updating description in PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async markReviewCommentAsResolved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        commentId: number;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, commentId } =
                params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // Data Center resolves comments by updating the comment state.
            const commentRes = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/comments/${commentId}`,
            );

            const response = await axiosClient.put(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/comments/${commentId}`,
                {
                    state: 'RESOLVED',
                    version: commentRes.data.version,
                },
            );

            return response.data;
        } catch (error) {
            this.logger.error({
                message: `Error marking comment ${params.commentId} as resolved in PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }
    async getReviewStatusByPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewState | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );
            const currentUser = await this.getCurrentUser({
                organizationAndTeamData,
            });

            if (!authDetails || !repoConfig || !currentUser) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // Fetch the PR to inspect the reviewers array
            const response = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}`,
            );

            const pr = response.data;
            const reviewers = pr.reviewers || [];

            // Find the current user in the reviewers list
            const userReview = reviewers.find(
                (r: any) => r.user?.name === currentUser.id,
            );

            if (!userReview) return null;

            if (userReview.status === 'APPROVED')
                return PullRequestReviewState.APPROVED;
            if (userReview.status === 'NEEDS_WORK')
                return PullRequestReviewState.CHANGES_REQUESTED;

            return null;
        } catch (error) {
            this.logger.error({
                message: `Error getting review status for PR #${params.prNumber} in Data Center`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async checkIfPullRequestShouldBeApproved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }) {
        try {
            const currentStatus = await this.getReviewStatusByPullRequest({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
            });

            // Only approve if not already approved
            if (currentStatus !== PullRequestReviewState.APPROVED) {
                await this.approvePullRequest(params);
            }
        } catch (error) {
            this.logger.error({
                message: `Error checking/approving DC PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async requestChangesPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
        criticalComments?: any[];
    }) {
        try {
            const {
                organizationAndTeamData,
                prNumber,
                repository,
                criticalComments,
            } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );
            const currentUser = await this.getCurrentUser({
                organizationAndTeamData,
            });

            if (!authDetails || !repoConfig || !currentUser) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // 1. Mark the PR as NEEDS_WORK for the current user
            // In Data Center, this is done by updating the participant status
            await axiosClient.put(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}/participants/${currentUser.id}`,
                {
                    user: { name: currentUser.id },
                    status: 'NEEDS_WORK',
                },
            );

            // 2. Post a summary comment with critical issues if provided
            if (criticalComments && criticalComments.length > 0) {
                const title =
                    '# Found critical issues please review the requested changes';
                const listOfCriticalIssues = criticalComments
                    .map(
                        (c) =>
                            `- ${c.comment?.suggestion?.oneSentenceSummary || 'Critical issue'}`,
                    )
                    .join('\n');

                const bodyFormatted = `${title}\n\n${listOfCriticalIssues}`;

                await this.createCommentInPullRequest({
                    organizationAndTeamData,
                    repository,
                    prNumber,
                    overallComment: bodyFormatted,
                });
            }

            this.logger.log({
                message: `Requested changes (NEEDS_WORK) on DC PR #${prNumber}`,
                context: BitbucketDataCenterService.name,
            });
        } catch (error) {
            this.logger.error({
                message: `Error requesting changes on DC PR #${params.prNumber}`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestsWithChangesRequested(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
    }): Promise<any[] | null> {
        try {
            // Fetch all open PRs
            const prs = await this.getPullRequests({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: {
                    id: params.repository.id!,
                    name: params.repository.name!,
                },
                filters: { state: PullRequestState.OPENED },
            });

            if (!prs) return null;

            const currentUser = await this.getCurrentUser({
                organizationAndTeamData: params.organizationAndTeamData,
            });
            const changesRequestedPRs = [];

            const authDetails = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                params.organizationAndTeamData,
                params.repository.id!,
            );
            if (!authDetails || !repoConfig || !currentUser) return null;
            const axiosClient = this.getAxiosInstance(authDetails);

            // We must inspect reviewers for each open PR
            for (const pr of prs) {
                try {
                    const response = await axiosClient.get(
                        `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${pr.number}`,
                    );
                    const reviewers = response.data.reviewers || [];
                    const userReview = reviewers.find(
                        (r: any) => r.user?.name === currentUser.id,
                    );

                    if (userReview && userReview.status === 'NEEDS_WORK') {
                        changesRequestedPRs.push({
                            title: pr.title,
                            number: pr.number,
                            reviewDecision:
                                PullRequestReviewState.CHANGES_REQUESTED,
                            date: new Date(pr.updated_at),
                        });
                    }
                } catch (e) {
                    continue; // skip on error fetching single PR details
                }
            }

            return changesRequestedPRs
                .sort((a, b) => a.date.getTime() - b.date.getTime())
                .map(({ date, ...rest }) => rest);
        } catch (error) {
            this.logger.error({
                message:
                    'Error fetching PRs with changes requested in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestsByRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        filters?: { startDate?: string; endDate?: string };
    }): Promise<any[]> {
        return this.getPullRequests({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            filters: {
                startDate: params.filters?.startDate
                    ? new Date(params.filters.startDate)
                    : undefined,
                endDate: params.filters?.endDate
                    ? new Date(params.filters.endDate)
                    : undefined,
            },
        });
    }

    async createAuthIntegration(params: any): Promise<any> {
        // Data Center leverages Token Authentication (or Basic) primarily.
        if (params.authMode === AuthMode.OAUTH) {
            throw new BadRequestException(
                'OAuth not natively supported in standard Data Center setup. Use PAT or Basic.',
            );
        }

        if (params.token) {
            const resolvedAuthMode =
                params.authMode === AuthMode.BASIC
                    ? AuthMode.BASIC
                    : AuthMode.TOKEN;

            const res = await this.authenticateWithToken({
                organizationAndTeamData: params.organizationAndTeamData,
                token: params.token,
                username: params.username,
                email: params.email,
                host: params.host,
                authMode: resolvedAuthMode,
            });

            // Trigger background syncs if MCP is configured
            if (this.mcpManagerService) {
                this.mcpManagerService.createKodusMCPIntegration(
                    params.organizationAndTeamData.organizationId,
                );
            }
            return res;
        }

        throw new BadRequestException(
            'Token or password required for Data Center integration.',
        );
    }

    async createOrUpdateIntegrationConfig(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        configKey: IntegrationConfigKey;
        configValue: any;
        type?: 'replace' | 'append';
    }): Promise<void> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.BITBUCKET,
            });

            if (!integration) return;

            await this.integrationConfigService.createOrUpdateConfig(
                params.configKey,
                params.configValue,
                integration?.uuid,
                params.organizationAndTeamData,
                params.type,
            );

            // If repositories are updated, ensure webhooks are generated for them
            if (params.configKey === IntegrationConfigKey.REPOSITORIES) {
                this.createWebhook(params.organizationAndTeamData).catch(
                    (err) => {
                        this.logger.warn({
                            message: 'Failed to background create webhooks',
                            context: BitbucketDataCenterService.name,
                            error: err,
                        });
                    },
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error creating/updating DC integration config',
                context: BitbucketDataCenterService.name,
                error,
            });
            throw new BadRequestException(error.message);
        }
    }

    async getRepositoryContentFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        file: any;
        pullRequest: any;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, file, pullRequest } =
                params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // Determine the commit or branch reference to fetch the file from
            const ref =
                pullRequest.head?.ref || pullRequest.base?.ref || 'master';
            const filePath = file.filename;

            // In Bitbucket Data Center, fetching raw file content uses the /raw endpoint
            const response = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/raw/${filePath}`,
                {
                    params: { at: ref },
                    responseType: 'text', // Ensure we get the raw string back
                },
            );

            return {
                data: {
                    content: response.data,
                    encoding: '', // Raw text, no base64 encoding needed unless specified by consumer
                },
            };
        } catch (error) {
            this.logger.error({
                message: `Error getting raw content for file ${params.file?.filename} in Data Center`,
                context: BitbucketDataCenterService.name,
                error,
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
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return [];

            const axiosClient = this.getAxiosInstance(authDetails);

            let branch = filters.branch;
            if (!branch) {
                branch = await this.getDefaultBranch({
                    organizationAndTeamData,
                    repository,
                });
            }

            // DC provides a flat /files endpoint which is extremely efficient for getting all paths
            const response = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/files`,
                {
                    params: {
                        limit: 100000,
                        at: branch,
                    },
                },
            );

            const allFilePaths: string[] = response.data.values || [];
            const { filePatterns, excludePatterns, maxFiles = 1000 } = filters;

            const filteredFiles: RepositoryFile[] = [];

            for (const filePath of allFilePaths) {
                if (maxFiles > 0 && filteredFiles.length >= maxFiles) break;

                // Simple pattern matching fallback if glob utils aren't perfectly aligned
                if (filePatterns && filePatterns.length > 0) {
                    const matchesInclude = filePatterns.some((pattern) =>
                        filePath.includes(pattern.replace(/\*/g, '')),
                    );
                    if (!matchesInclude) continue;
                }

                if (excludePatterns && excludePatterns.length > 0) {
                    const matchesExclude = excludePatterns.some((pattern) =>
                        filePath.includes(pattern.replace(/\*/g, '')),
                    );
                    if (matchesExclude) continue;
                }

                filteredFiles.push({
                    filename: filePath.split('/').pop() || '',
                    sha: '', // Not provided in the /files flat list response
                    size: -1,
                    path: filePath,
                    type: 'blob', // Flat files list only returns files, not directories
                });
            }

            return filteredFiles;
        } catch (error) {
            this.logger.error({
                message: 'Error getting all repository files from Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return [];
        }
    }

    async getPullRequestsForRTTM(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: any;
    }): Promise<PullRequestCodeReviewTime[] | null> {
        try {
            const { organizationAndTeamData, filters = {} } = params;
            const { startDate, endDate } = filters.period || {};

            // Fetch ALL state PRs because DC doesn't easily support multi-state filtering via query
            const rawPrs = await this.getPullRequests({
                organizationAndTeamData,
                filters: { state: PullRequestState.ALL },
            });

            if (!rawPrs) return null;

            // Filter down to MERGED and DECLINED, and enforce the date boundaries
            const validPrs = rawPrs.filter((pr) => {
                if (
                    pr.state !== PullRequestState.MERGED &&
                    pr.state !== PullRequestState.CLOSED
                )
                    return false;

                const updatedDate = new Date(pr.updated_at);
                let isValid = true;

                if (startDate && updatedDate < new Date(startDate))
                    isValid = false;
                if (endDate && updatedDate > new Date(endDate)) isValid = false;

                return isValid;
            });

            return validPrs.map((pr) => ({
                id: pr.id as any,
                created_at: pr.created_at,
                closed_at: pr.closed_at || pr.updated_at, // Use updated_at as fallback for closed_at
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull requests for RTTM in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async deleteWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        try {
            const { organizationAndTeamData } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetails) return;

            const axiosClient = this.getAxiosInstance(authDetails);

            const repositories = <Repositories[]>(
                    await this.integrationConfigService.findOne({
                        team: { uuid: organizationAndTeamData.teamId },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                    })
                )?.configValue || [];

            const webhookUrl =
                this.configService.get<string>(
                    'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
                ) ?? process.env.GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK;

            if (!webhookUrl) return;

            for (const repo of repositories) {
                const projectKey = repo.workspaceId;
                const repoSlug = repo.name;

                try {
                    // Fetch existing webhooks
                    const existingHooksRes = await axiosClient.get(
                        `/projects/${projectKey}/repos/${repoSlug}/webhooks`,
                    );
                    const existingHooks = existingHooksRes.data.values || [];

                    // Find our webhook
                    const hookToDelete = existingHooks.find(
                        (hook: any) => hook.url === webhookUrl,
                    );

                    if (hookToDelete) {
                        await axiosClient.delete(
                            `/projects/${projectKey}/repos/${repoSlug}/webhooks/${hookToDelete.id}`,
                        );
                        this.logger.log({
                            message: `Deleted webhook successfully for DC repository ${repoSlug}`,
                            context: BitbucketDataCenterService.name,
                        });
                    }
                } catch (repoErr) {
                    this.logger.error({
                        message: `Error deleting webhook for DC repository ${repoSlug}`,
                        context: BitbucketDataCenterService.name,
                        error: repoErr,
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message:
                    'Error authenticating for webhook deletion in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
        }
    }

    async getChangedFilesSinceLastCommit(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        lastCommit: any;
    }): Promise<any | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                prNumber,
                lastCommit,
            } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repository.id || repository.name,
            );

            if (!authDetails || !repoConfig) return null;

            const axiosClient = this.getAxiosInstance(authDetails);

            // In Data Center, we can get changes between the PR's latest commit and the provided lastCommit
            const prResponse = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/pull-requests/${prNumber}`,
            );
            const latestPrCommit = prResponse.data.fromRef.latestCommit;

            const diffResponse = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/compare/changes`,
                {
                    params: {
                        from: lastCommit.sha,
                        to: latestPrCommit,
                        limit: 1000,
                    },
                },
            );

            const changes = diffResponse.data.values || [];

            return changes.map((change: any) => ({
                filename: change.path.toString,
                sha: latestPrCommit,
                status:
                    change.type === 'MODIFY'
                        ? 'modified'
                        : change.type === 'ADD'
                          ? 'added'
                          : 'removed',
                additions: 0,
                deletions: 0,
                changes: 0,
                patch: null, // Requires individual diff endpoint calls in DC
                content: null,
            }));
        } catch (error) {
            this.logger.error({
                message:
                    'Error fetching changed files since last commit in Data Center',
                context: BitbucketDataCenterService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestByNumber(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<any | null> {
        // This is essentially an alias for getPullRequest.
        return this.getPullRequest({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            prNumber: params.prNumber,
        });
    }

    async getRepositoryTreeByDirectory(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        directoryPath?: string;
    }): Promise<any[]> {
        try {
            const {
                organizationAndTeamData,
                repositoryId,
                directoryPath = '',
            } = params;
            const authDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            const repoConfig = await this.getRepoConfig(
                organizationAndTeamData,
                repositoryId,
            );

            if (!authDetails || !repoConfig) return [];

            const axiosClient = this.getAxiosInstance(authDetails);

            // Clean the path to ensure it doesn't have a leading slash which breaks the Data Center API
            const cleanPath = directoryPath.startsWith('/')
                ? directoryPath.substring(1)
                : directoryPath;

            // Bitbucket Data Center uses the /browse endpoint to look at specific directories
            const response = await axiosClient.get(
                `/projects/${repoConfig.workspaceId}/repos/${repoConfig.name}/browse/${cleanPath}`,
                {
                    params: { limit: 1000 },
                },
            );

            // The /browse endpoint returns the file/directory metadata inside a 'children' object
            const children = response.data.children?.values || [];

            return children.map((child: any) => {
                const isDirectory = child.type === 'DIRECTORY';
                // Construct the full path
                const fullPath = cleanPath
                    ? `${cleanPath}/${child.path.toString}`
                    : child.path.toString;

                return {
                    path: fullPath,
                    type: isDirectory ? 'directory' : 'file',
                    sha: '', // Data Center doesn't provide SHA directly in the browse endpoint
                    size: child.size,
                    url: '',
                    hasChildren: isDirectory,
                };
            });
        } catch (error) {
            this.logger.error({
                message: `Error getting repository tree for directory '${params.directoryPath}' in Data Center`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return [];
        }
    }

    async isDraftPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<boolean> {
        try {
            // We already implemented the draft detection logic in our `transformDataCenterPR` method
            // inside `getPullRequest`, so we can reuse it here.
            const pr = await this.getPullRequest({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
            });

            return pr?.isDraft ?? false;
        } catch (error) {
            this.logger.error({
                message: `Error checking if PR #${params.prNumber} is a draft in Data Center`,
                context: BitbucketDataCenterService.name,
                error,
            });
            return false;
        }
    }

    async getRepositoryContentBatch(
        _params: any,
    ): Promise<Map<string, any> | null> {
        // Not implemented for Bitbucket Data Center — callers fall
        // back to per-file `getRepositoryContentFile`.
        return null;
    }

    async getUsersByUsername(
        _params: any,
    ): Promise<Map<string, any> | null> {
        // Not implemented for Bitbucket Data Center — callers fall
        // back to per-user `getUserByUsername`.
        return null;
    }
}
