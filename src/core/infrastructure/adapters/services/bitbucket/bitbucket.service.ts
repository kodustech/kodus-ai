import {
    CommentResult,
    FileChange,
    Repository,
} from '@/config/types/general/codeReview.type';
import { Commit } from '@/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TreeItem } from '@/config/types/general/tree.type';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { BitbucketAuthDetail } from '@/core/domain/authIntegrations/types/bitbucket-auth-detail.type';
import { IBitbucketService } from '@/core/domain/bitbucket/contracts/bitbucket.service.contract';
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
    ReactionsInComments,
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { RepositoryFile } from '@/core/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import { AuthorContribution } from '@/core/domain/pullRequests/interfaces/authorContributor.interface';
import { IRepository } from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import { CreateAuthIntegrationStatus } from '@/shared/domain/enums/create-auth-integration-status.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { CacheService } from '@/shared/utils/cache/cache.service';
import { hasKodyMarker } from '@/shared/utils/codeManagement/codeCommentMarkers';
import { decrypt, encrypt } from '@/shared/utils/crypto';
import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { CodeManagementConnectionStatus } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@/shared/utils/glob-utils';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import {
    LLMModelProvider,
    LLMProviderService,
    MODEL_STRATEGIES,
} from '@kodus/kodus-common/llm';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APIClient, Bitbucket, Schema } from 'bitbucket';
import { Response as BitbucketResponse } from 'bitbucket/src/request/types';
import moment from 'moment';
import { v4 } from 'uuid';
import { MCPManagerService } from '../../mcp/services/mcp-manager.service';
import { PinoLoggerService } from '../logger/pino.service';
import { PromptService } from '../prompt.service';

@Injectable()
@IntegrationServiceDecorator(PlatformType.BITBUCKET, 'codeManagement')
export class BitbucketService
    implements
        IBitbucketService,
        Omit<
            ICodeManagementService,
            | 'getOrganizations'
            | 'getListOfValidReviews'
            | 'getUserByEmailOrName'
            | 'getPullRequestReviewThreads'
            | 'getUserById'
            | 'getDataForCalculateDeployFrequency'
            | 'getCommitsByReleaseMode'
            | 'getAuthenticationOAuthToken'
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

    private readonly USER_CACHE_TTL = 60 * 60 * 1000; // 1 hour

    async getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<PullRequestAuthor[]> {
        try {
            const startDate = new Date();
            const endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() - 60);

            // Use optimized method that limits PRs per repository for better performance
            const pullRequests = await this.getPullRequestsForAuthors({
                organizationAndTeamData: params.organizationAndTeamData,
                filters: {
                    startDate: endDate, // Reversing the dates to fetch the last 15 days
                    endDate: startDate,
                },
                limitPerRepo: 100, // Limit to 100 most recent PRs per repository
            });

            // Group the PRs by author and count the contributions
            const authorContributions = pullRequests.reduce<
                Record<string, AuthorContribution>
            >((acc, pr) => {
                const authorId = pr.user.id;
                const authorName = pr.user.name || pr.user.login || pr.user.id;

                if (!authorId) {
                    this.logger.warn({
                        message: 'Skipping PR with missing author ID',
                        context: BitbucketService.name,
                        metadata: {
                            organizationAndTeamData:
                                params?.organizationAndTeamData,
                            pullRequest: pr?.number,
                        },
                    });
                    return acc;
                }

                if (!acc[authorId]) {
                    acc[authorId] = {
                        id: authorId,
                        name: authorName,
                        contributions: 0,
                    };
                }

                acc[authorId].contributions++;
                return acc;
            }, {});

            // Convert to array and sort by number of contributions
            const sortedAuthors = Object.values<AuthorContribution>(
                authorContributions,
            ).sort((a, b) => a.name.localeCompare(b.name));

            return sortedAuthors.map((author) => ({
                id: this.sanitizeUUID(author.id.toString()),
                name: author.name,
                type: 'user',
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull request authors',
                context: BitbucketService.name,
                error,
                metadata: {
                    organizationAndTeamData: params?.organizationAndTeamData,
                },
            });
            throw error;
        }
    }

    async getPullRequestsWithChangesRequested(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
    }): Promise<PullRequestsWithChangesRequested[] | null> {
        try {
            const { organizationAndTeamData, repository } = params;

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                return null;
            }

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                return null;
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            // takes a while
            const activities: any[] = await bitbucketAPI.pullrequests
                .listActivitiesForRepo({
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    pagelen: 50,
                })
                .then((res) => this.getPaginatedResults(bitbucketAPI, res));

            return activities
                .filter((activity) => activity.changes_requested)
                .map((filteredActivity) => ({
                    title: filteredActivity.pull_request.title ?? '',
                    number: filteredActivity.pull_request.id,
                    reviewDecision: PullRequestReviewState.CHANGES_REQUESTED,
                    date: new Date(filteredActivity.changes_requested.date),
                }))
                .sort((a, b) => a.date.getTime() - b.date.getTime())
                .map(({ date, ...rest }) => rest);
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests with changes requested',
                context: BitbucketService.name,
                serviceName:
                    'BitbucketService getPullRequestsWithChangesRequested',
                error: error,
                metadata: {
                    params,
                },
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
            const bitbucketAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                throw new BadRequestException('Installation not found');
            }
            const fullBitbucketUrl = `https://bitbucket.org/${params?.repository?.fullName}`;

            return {
                organizationId: params?.organizationAndTeamData?.organizationId,
                repositoryId: params?.repository?.id,
                repositoryName: params?.repository?.name,
                url: fullBitbucketUrl,
                branch: params?.repository?.defaultBranch,
                provider: PlatformType.BITBUCKET,
                auth: {
                    username: bitbucketAuthDetail.username,
                    type: bitbucketAuthDetail.authMode,
                    token: decrypt(bitbucketAuthDetail.appPassword),
                },
            };
        } catch (error) {
            this.logger.error({
                message: `Failed to clone repository ${params?.repository?.fullName} from Bitbucket`,
                context: BitbucketService.name,
                error: error.message,
                metadata: params,
            });
            return null;
        }
    }

    /**
     * Retrieves pull requests from Bitbucket based on the provided parameters.
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
                    message:
                        'Organization ID is required to fetch pull requests',
                    context: BitbucketService.name,
                    metadata: params,
                });

                return [];
            }

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const allRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !bitbucketAuthDetail ||
                !allRepositories ||
                allRepositories.length === 0
            ) {
                this.logger.warn({
                    message: 'Bitbucket auth details or repositories not found',
                    context: BitbucketService.name,
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
                        context: BitbucketService.name,
                        metadata: params,
                    });

                    return [];
                }
                reposToProcess = [foundRepo];
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const promises = reposToProcess.map((r) =>
                this.getPullRequestsByRepo({
                    bitbucketAPI,
                    repo: r,
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
                message: 'Error fetching pull requests from Bitbucket',
                context: BitbucketService.name,
                error,
                metadata: params,
            });
            return [];
        }
    }

    /**
     * Retrieves pull requests from Bitbucket with optimization for author discovery.
     * Limits the number of PRs fetched per repository to improve performance.
     * @param params - The parameters for fetching pull requests.
     * @param params.organizationAndTeamData - The organization and team data.
     * @param params.repository - Optional filter for a specific repository name.
     * @param params.filters - Optional filters for dates, state, author, and branch.
     * @param params.limitPerRepo - Maximum number of PRs to fetch per repository (default: 100).
     * @returns A promise that resolves to an array of transformed PullRequest objects.
     */
    async getPullRequestsForAuthors(params: {
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
        limitPerRepo?: number;
    }): Promise<PullRequest[]> {
        const {
            organizationAndTeamData,
            repository,
            filters = {},
            limitPerRepo = 100,
        } = params;

        try {
            if (!organizationAndTeamData.organizationId) {
                this.logger.warn({
                    message:
                        'Organization ID is required to fetch pull requests',
                    context: BitbucketService.name,
                    metadata: params,
                });

                return [];
            }

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const allRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !bitbucketAuthDetail ||
                !allRepositories ||
                allRepositories.length === 0
            ) {
                this.logger.warn({
                    message: 'Bitbucket auth details or repositories not found',
                    context: BitbucketService.name,
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
                        context: BitbucketService.name,
                        metadata: params,
                    });

                    return [];
                }
                reposToProcess = [foundRepo];
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const promises = reposToProcess.map((r) =>
                this.getPullRequestsByRepoForAuthors({
                    bitbucketAPI,
                    repo: r,
                    filters,
                    limit: limitPerRepo,
                }),
            );

            const results = await Promise.all(promises);
            const rawPullRequests = results.flat();

            return rawPullRequests.map((rawPr) =>
                this.transformPullRequest(rawPr, organizationAndTeamData),
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error fetching pull requests for authors from Bitbucket',
                context: BitbucketService.name,
                error,
                metadata: params,
            });
            return [];
        }
    }

    /**
     * Retrieves pull requests from a specific Bitbucket repository.
     * @param params - The parameters for fetching, including the API instance, repository object, and filters.
     * @returns A promise that resolves to an array of raw pull request data.
     */
    private async getPullRequestsByRepo(params: {
        bitbucketAPI: InstanceType<typeof Bitbucket>;
        repo: Repositories;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            state?: PullRequestState;
            author?: string;
            branch?: string;
        };
    }): Promise<Schema.Pullrequest[]> {
        const { bitbucketAPI, repo, filters = {} } = params;
        const { startDate, endDate, state, author, branch } = filters;

        // see https://github.com/MunifTanjim/node-bitbucket/issues/74
        bitbucketAPI.pullrequests.list =
            // @ts-ignore
            bitbucketAPI.pullrequests.list.defaults({
                request: {
                    validate: {
                        state: {
                            enum: undefined,
                            type: 'array',
                            items: {
                                enum: [
                                    'OPEN',
                                    'DECLINED',
                                    'MERGED',
                                    'SUPERSEDED',
                                ],
                                type: 'string',
                            },
                        },
                    },
                },
            });

        const response = await bitbucketAPI.pullrequests.list({
            repo_slug: `{${repo.id}}`,
            workspace: `{${repo.workspaceId}}`,
            // @ts-ignore - see above
            state: state
                ? this._prStateMapReversed.get(state)
                : this._prStateMapReversed.get(PullRequestState.ALL), // get all states if not specified
            sort: '-created_on', // Sort by creation date, descending
            fields: '+values.participants,+values.reviewers,+values.draft',
        });

        const pullRequests = await this.getPaginatedResults(
            bitbucketAPI,
            response,
        );

        return pullRequests.filter((pr) => {
            let isValid = true;

            if (isValid && startDate) {
                isValid = new Date(pr.created_on) >= startDate;
            }

            if (isValid && endDate) {
                isValid = new Date(pr.created_on) <= endDate;
            }

            if (isValid && author) {
                isValid =
                    pr?.author?.display_name?.toLowerCase() ===
                    author.toLowerCase();
            }

            if (isValid && branch) {
                isValid =
                    pr.destination?.branch?.name?.toLowerCase() ===
                    branch.toLowerCase();
            }

            return isValid;
        });
    }

    /**
     * Retrieves pull requests from a specific Bitbucket repository with a limit for optimization.
     * Used specifically for scenarios where we only need recent data (like authors).
     * @param params - The parameters for fetching, including the API instance, repository object, and filters.
     * @param limit - Maximum number of pull requests to fetch per repository.
     * @returns A promise that resolves to an array of raw pull request data (limited).
     */
    private async getPullRequestsByRepoForAuthors(params: {
        bitbucketAPI: InstanceType<typeof Bitbucket>;
        repo: Repositories;
        filters?: {
            startDate?: Date;
            endDate?: Date;
            state?: PullRequestState;
            author?: string;
            branch?: string;
        };
        limit?: number;
    }): Promise<Schema.Pullrequest[]> {
        const { bitbucketAPI, repo, filters = {}, limit = 100 } = params;
        const { startDate, endDate, state, author, branch } = filters;

        // see https://github.com/MunifTanjim/node-bitbucket/issues/74
        bitbucketAPI.pullrequests.list =
            // @ts-ignore
            bitbucketAPI.pullrequests.list.defaults({
                request: {
                    validate: {
                        state: {
                            enum: undefined,
                            type: 'array',
                            items: {
                                enum: [
                                    'OPEN',
                                    'DECLINED',
                                    'MERGED',
                                    'SUPERSEDED',
                                ],
                                type: 'string',
                            },
                        },
                    },
                },
            });

        const response = await bitbucketAPI.pullrequests.list({
            repo_slug: `{${repo.id}}`,
            workspace: `{${repo.workspaceId}}`,
            // @ts-ignore - see above
            state: state
                ? this._prStateMapReversed.get(state)
                : this._prStateMapReversed.get(PullRequestState.ALL), // get all states if not specified
            sort: '-created_on', // Sort by creation date, descending
            fields: '+values.participants,+values.reviewers,+values.draft',
        });

        // Use the limited pagination method
        const pullRequests = await this.getPaginatedResultsWithLimit(
            bitbucketAPI,
            response,
            limit,
        );

        return pullRequests.filter((pr) => {
            let isValid = true;

            if (isValid && startDate) {
                isValid = new Date(pr.created_on) >= startDate;
            }

            if (isValid && endDate) {
                isValid = new Date(pr.created_on) <= endDate;
            }

            if (isValid && author) {
                isValid =
                    pr?.author?.display_name?.toLowerCase() ===
                    author.toLowerCase();
            }

            if (isValid && branch) {
                isValid =
                    pr.destination?.branch?.name?.toLowerCase() ===
                    branch.toLowerCase();
            }

            return isValid;
        });
    }

    async getPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequest | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            if (
                !organizationAndTeamData.organizationId ||
                !repository.id ||
                !prNumber
            ) {
                return null;
            }

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                return null;
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                return null;
            }

            const prDetails = (
                await bitbucketAPI.pullrequests.get({
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    pull_request_id: prNumber,
                    fields: '+values.participants,+values.reviewers,+values.draft',
                })
            ).data;

            return this.transformPullRequest(
                prDetails,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull request details',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getPullRequestDetails',
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
                limit?: number;
            };
        };
    }): Promise<Repositories[]> {
        try {
            const { organizationAndTeamData } = params;

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                return [];
            }

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: organizationAndTeamData.teamId,
                },
                platform: PlatformType.BITBUCKET,
            });

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: organizationAndTeamData.teamId },
                });

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const workspaces = await bitbucketAPI.workspaces
                .getWorkspaces({ pagelen: 50 })
                .then((res) => this.getPaginatedResults(bitbucketAPI, res));

            const workspacesWithRepos = await Promise.all(
                workspaces.map((workspace) =>
                    bitbucketAPI.repositories
                        .list({
                            workspace: `${workspace.uuid}`,
                            pagelen: 50,
                        })
                        .then((res) =>
                            this.getPaginatedResults(bitbucketAPI, res),
                        )
                        .then((res) => ({ workspace, repos: res })),
                ),
            );

            const repositories: Repositories[] = workspacesWithRepos.flatMap(
                ({ workspace, repos }) =>
                    repos.map((repo) =>
                        this.transformRepo(repo, workspace, integrationConfig),
                    ),
            );

            return repositories;
        } catch (error) {
            this.logger.error({
                message: 'Error to get repositories',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getRepositories',
                error: error,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(error);
        }
    }

    private async getRecentPullRequestsCount(params: {
        bitbucketAPI: InstanceType<typeof Bitbucket>;
        repoId: string;
        workspaceId: string;
        days: number;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<number> {
        try {
            const sinceDate = moment()
                .subtract(Math.max(params.days, 1), 'days')
                .toISOString();

            const response = await params.bitbucketAPI.pullrequests.list({
                repo_slug: `{${params.repoId}}`,
                workspace: `{${params.workspaceId}}`,
                q: `created_on >= "${sinceDate}"`,
                sort: '-created_on',
                pagelen: 50,
            });

            const pullRequests = await this.getPaginatedResults(
                params.bitbucketAPI,
                response,
            );

            return pullRequests.length;
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to count recent pull requests from Bitbucket repository',
                context: BitbucketService.name,
                error: error,
                metadata: {
                    repoId: params.repoId,
                    workspaceId: params.workspaceId,
                    organizationId:
                        params.organizationAndTeamData?.organizationId,
                    teamId: params.organizationAndTeamData?.teamId,
                },
            });
            return 0;
        }
    }

    private transformRepo(
        repo: Schema.Repository,
        workspace: Schema.Workspace,
        integrationConfig: IntegrationConfigEntity,
    ): Repositories {
        const { uuid, name, links, is_private, mainbranch, project } = repo;
        const { slug, uuid: workspaceUuid } = workspace;

        return {
            id: this.sanitizeUUID(uuid),
            name: name ?? '',
            http_url: links?.html?.href ?? '',
            avatar_url: links?.avatar?.href ?? '',
            organizationName: slug ?? '',
            visibility: is_private ? 'private' : 'public',
            selected:
                integrationConfig?.configValue?.some(
                    (repository) => repository?.name === name,
                ) ?? false,
            default_branch: mainbranch?.name ?? '',
            workspaceId: this.sanitizeUUID(workspaceUuid),
            project: {
                id: this.sanitizeUUID(project?.uuid),
                name: project?.name ?? '',
            },
            lastActivityAt: repo?.updated_on || repo?.created_on,
        };
    }

    async getWorkflows(organizationAndTeamData: OrganizationAndTeamData) {
        try {
            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!bitbucketAuthDetail || !repositories) {
                return [];
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const allWorkflows = await Promise.all(
                repositories.map((repo) =>
                    bitbucketAPI.pipelines
                        .list({
                            repo_slug: `{${repo.id}}`,
                            workspace: `{${repo.workspaceId}}`,
                            pagelen: 50,
                        })
                        .then((res) =>
                            this.getPaginatedResults(bitbucketAPI, res),
                        )
                        .then((res) => ({ repo, workflows: res })),
                ),
            );

            const workflows = allWorkflows.filter(
                ({ workflows }) => workflows.length > 0,
            );

            if (!workflows || workflows.length === 0) {
                return [];
            }

            let llm = this.llmProviderService.getLLMProvider({
                model: MODEL_STRATEGIES[LLMModelProvider.OPENAI_GPT_4O]
                    .modelName,
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
        } catch (error) {
            this.logger.error({
                message: 'Error to get workflows',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getWorkflows',
                error: error,
                metadata: {
                    organizationAndTeamData,
                },
            });
            return [];
        }
    }

    async getListMembers(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<{ name: string; id: string | number }[]> {
        try {
            const { organizationAndTeamData } = params;

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                return [];
            }

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!repositories?.length) {
                return [];
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const workspaceIdentifiers = Array.from(
                new Set(
                    repositories
                        .map((repo) => {
                            if (repo.organizationName) {
                                return repo.organizationName;
                            }

                            if (repo.workspaceId) {
                                return `{${repo.workspaceId}}`;
                            }

                            return null;
                        })
                        .filter(
                            (workspace): workspace is string => !!workspace,
                        ),
                ),
            );

            if (!workspaceIdentifiers.length) {
                return [];
            }

            const allMembers = await Promise.all(
                workspaceIdentifiers.map((workspace) =>
                    bitbucketAPI.workspaces
                        .getMembersForWorkspace({
                            workspace,
                            pagelen: 50,
                        })
                        .then((res) =>
                            this.getPaginatedResults<Schema.WorkspaceMembership>(
                                bitbucketAPI,
                                res,
                            ),
                        ),
                ),
            );

            const uniqueMembers = new Map<
                string,
                { name: string; id: string; type: string }
            >();

            allMembers.forEach((memberships) => {
                memberships.forEach((membership) => {
                    const memberId = this.sanitizeUUID(
                        membership?.user?.uuid ?? '',
                    );

                    if (!memberId || uniqueMembers.has(memberId)) {
                        return;
                    }

                    const user =
                        (membership?.user as
                            | (Schema.Account & {
                                  nickname?: string;
                                  username?: string;
                              })
                            | undefined) ?? undefined;

                    const displayName =
                        typeof user?.display_name === 'string'
                            ? user.display_name
                            : undefined;
                    const nickname =
                        typeof user?.nickname === 'string'
                            ? user.nickname
                            : undefined;
                    const username =
                        typeof user?.username === 'string'
                            ? user.username
                            : undefined;

                    uniqueMembers.set(memberId, {
                        name: displayName ?? nickname ?? username ?? memberId,
                        id: memberId,
                        type: 'user',
                    });
                });
            });

            return Array.from(uniqueMembers.values());
        } catch (error) {
            this.logger.error({
                message: 'Error to get list members',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getListMembers',
                error: error,
                metadata: {
                    params,
                },
            });
            return [];
        }
    }

    async verifyConnection(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<CodeManagementConnectionStatus> {
        try {
            const { organizationAndTeamData } = params;

            if (!organizationAndTeamData.organizationId)
                return {
                    platformName: PlatformType.BITBUCKET,
                    isSetupComplete: false,
                    hasConnection: false,
                    config: {},
                };

            const [bitbucketRepositories, bitbucketOrg] = await Promise.all([
                this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                ),
                this.integrationService.findOne({
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    status: true,
                    platform: PlatformType.BITBUCKET,
                }),
            ]);

            const hasRepositories = bitbucketRepositories?.length > 0;

            const authMode = bitbucketOrg?.authIntegration?.authDetails
                ?.authMode
                ? bitbucketOrg?.authIntegration?.authDetails?.authMode
                : AuthMode.TOKEN;

            const isSetupComplete =
                hasRepositories &&
                authMode === AuthMode.TOKEN &&
                !!bitbucketOrg?.authIntegration?.authDetails?.appPassword;

            return {
                platformName: PlatformType.BITBUCKET,
                isSetupComplete,
                hasConnection: !!bitbucketOrg,
                config: {
                    hasRepositories: hasRepositories,
                    status: bitbucketRepositories?.installationStatus,
                },
                category: IntegrationCategory.CODE_MANAGEMENT,
            };
        } catch (err) {
            this.logger.error({
                message: 'Error to verify connection',
                context: BitbucketService.name,
                serviceName: 'BitbucketService verifyConnection',
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async predictDeploymentType(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }) {
        const { organizationAndTeamData } = params;
        try {
            const workflows = await this.getWorkflows(organizationAndTeamData);

            if (workflows && workflows.length > 0) {
                return this.formatDeploymentTypeFromDeploy(workflows);
            }

            const deployments = await this.getDeployments(
                organizationAndTeamData,
            );

            if (deployments && deployments.length > 0) {
                return {
                    type: 'releases',
                    madeBy: 'Kody',
                };
            }

            const prs = await this.getPullRequests({
                organizationAndTeamData,
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
                message: 'Error to predict deployment type',
                context: BitbucketService.name,
                serviceName: 'PredictDeploymentType',
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                },
            });
            return null;
        }
    }

    private async getDeployments(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!bitbucketAuthDetail || !repositories) {
                return null;
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const allDeployments = await Promise.all(
                repositories.map((repo) =>
                    bitbucketAPI.deployments
                        .list({
                            repo_slug: `{${repo.id}}`,
                            workspace: `{${repo.workspaceId}}`,
                            pagelen: 50,
                        })
                        .then((res) =>
                            this.getPaginatedResults(bitbucketAPI, res),
                        ),
                ),
            );

            const deployments = allDeployments.filter(
                (deployment) => deployment.length > 0,
            );

            return deployments;
        } catch (error) {
            this.logger.error({
                message: 'Error to get deployments',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getDeployments',
                error: error,
                metadata: {
                    organizationAndTeamData,
                },
            });
            return [];
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

    async savePredictedDeploymentType(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }) {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: params.organizationAndTeamData.teamId,
                },
                platform: PlatformType.BITBUCKET,
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
        } catch (error) {
            this.logger.error({
                message: 'Error to save predicted deployment type',
                context: BitbucketService.name,
                serviceName: 'BitbucketService savePredictedDeploymentType',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async getPullRequestsWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: any;
    }): Promise<PullRequestWithFiles[] | null> {
        try {
            const { organizationAndTeamData } = params;

            const filters = params?.filters ?? {};
            const { prStatus } = filters ?? 'OPEN';
            const perRepoLimit = Math.min(Math.max(filters?.limit || 5, 1), 10);
            const repoFilter = filters?.repositoryId
                ? new Set([String(filters.repositoryId)])
                : null;
            const useFastPath = Boolean(
                filters?.repositoryId || filters?.limit,
            );

            const stateMap = {
                open: PullRequestState.OPENED.toUpperCase(),
                closed: 'DECLINED',
                merged: PullRequestState.MERGED.toUpperCase(),
            };

            // Normalize the input to lowercase and look it up in the stateMap
            const normalizedStatus =
                stateMap[prStatus.toLowerCase()] || PullRequestState.OPENED; // Default to OPENED if not found

            const { startDate, endDate } = filters?.period || {};

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!bitbucketAuthDetail || !repositories) {
                return null;
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const reposWithPrs = await Promise.all(
                repositories.map(async (repo) => {
                    if (
                        repoFilter &&
                        !repoFilter.has(String(repo.id)) &&
                        !repoFilter.has(String(repo.name))
                    ) {
                        return { repo, prs: [] };
                    }

                    let prs = await bitbucketAPI.pullrequests
                        .list({
                            repo_slug: `{${repo.id}}`,
                            workspace: `{${repo.workspaceId}}`,
                            state: normalizedStatus,
                            pagelen: 50,
                        })
                        .then((res) =>
                            this.getPaginatedResults(bitbucketAPI, res),
                        );

                    if (startDate && endDate) {
                        const start = new Date(startDate);
                        const end = new Date(endDate);

                        prs = prs.filter((pr) => {
                            const createdOn = new Date(pr.created_on);
                            return createdOn >= start && createdOn <= end;
                        });
                    }

                    if (useFastPath) {
                        prs = prs
                            .sort(
                                (a, b) =>
                                    new Date(b.created_on).getTime() -
                                    new Date(a.created_on).getTime(),
                            )
                            .slice(0, perRepoLimit);
                    }

                    return { repo, prs };
                }),
            );

            const pullRequestsWithFiles: PullRequestWithFiles[] = [];

            await Promise.all(
                reposWithPrs.map(async ({ repo, prs }) => {
                    const prsWithDiffs = await Promise.all(
                        prs.map((pr) => {
                            if (useFastPath && filters?.skipFiles) {
                                return Promise.resolve({ pr, diffs: [] });
                            }

                            return bitbucketAPI.pullrequests
                                .getDiffStat({
                                    pull_request_id: pr.id,
                                    repo_slug: `{${repo.id}}`,
                                    workspace: `{${repo.workspaceId}}`,
                                })
                                .then((res) =>
                                    this.getPaginatedResults<Schema.Diffstat>(
                                        bitbucketAPI,
                                        res,
                                    ),
                                )
                                .then((res) => ({ pr, diffs: res }));
                        }),
                    );

                    const prsWithFiles: PullRequestWithFiles[] =
                        prsWithDiffs.map(({ pr, diffs }) => {
                            const pullRequestFiles: PullRequestFile[] =
                                diffs.map((diff) => ({
                                    additions: diff.lines_added,
                                    changes:
                                        diff.lines_added + diff.lines_removed,
                                    deletions: diff.lines_removed,
                                    status: diff.status,
                                }));

                            return {
                                id: pr.id,
                                pull_number: pr.id,
                                state: pr.state,
                                title: pr.title,
                                repository: {
                                    id: repo.id,
                                    name: repo.name,
                                },
                                pullRequestFiles,
                            };
                        });

                    pullRequestsWithFiles.push(...prsWithFiles);
                }),
            );

            return pullRequestsWithFiles;
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests with files',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getPullRequestsWithFiles',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async getPullRequestsForRTTM(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: any;
    }): Promise<PullRequestCodeReviewTime[] | null> {
        try {
            const { organizationAndTeamData } = params;

            const filters = params?.filters ?? {};
            const { startDate, endDate } = filters?.period || {};

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!bitbucketAuthDetail || !repositories) {
                return null;
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const query =
                startDate && endDate
                    ? ` AND updated_on >= ${startDate} AND updated_on <= ${endDate}`
                    : '';

            const mergedPullRequests = await Promise.all(
                repositories.map((repo) =>
                    bitbucketAPI.pullrequests
                        .list({
                            repo_slug: `{${repo.id}}`,
                            workspace: `{${repo.workspaceId}}`,
                            q: `(state = 'MERGED' OR state = 'DECLINED')${query}`,
                            pagelen: 50,
                        })
                        .then((res) =>
                            this.getPaginatedResults(bitbucketAPI, res),
                        ),
                ),
            );

            const formattedPullRequests: PullRequestCodeReviewTime[] =
                mergedPullRequests.flatMap((prs) =>
                    prs.map((pr) => ({
                        id: pr.id,
                        created_at: pr.created_on,
                        closed_at: pr.updated_on,
                    })),
                );

            return formattedPullRequests;
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests for RTTM',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getPullRequestsForRTTM',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
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
            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const configuredRepositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (
                !bitbucketAuthDetail ||
                !configuredRepositories ||
                configuredRepositories.length === 0
            ) {
                this.logger.warn({
                    message:
                        'Bitbucket auth details or repositories not found.',
                    context: BitbucketService.name,
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
                        context: BitbucketService.name,
                        metadata: params,
                    });
                    return [];
                }
                reposToProcess = [foundRepo];
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const promises = reposToProcess.map((repo) =>
                this.getCommitsByRepo({
                    bitbucketAPI,
                    workspaceId: repo.workspaceId,
                    repoId: repo.id,
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
                message: 'Error fetching commits from Bitbucket',
                context: BitbucketService.name,
                error: error,
                metadata: params,
            });
            return [];
        }
    }

    /**
     * Fetches and filters commits for a single Bitbucket repository.
     * @param params Parameters including the API client, repo identifiers, and filters.
     * @returns A promise that resolves to an array of raw commit data.
     */
    private async getCommitsByRepo(params: {
        bitbucketAPI: InstanceType<typeof Bitbucket>;
        workspaceId: string;
        repoId: string;
        filters: {
            startDate?: Date;
            endDate?: Date;
            author?: string;
            branch?: string;
        };
    }): Promise<Schema.Commit[]> {
        const { bitbucketAPI, workspaceId, repoId, filters = {} } = params;
        const { startDate, endDate, author, branch } = filters;

        const initialResponse = await bitbucketAPI.commits.list({
            repo_slug: `{${repoId}}`,
            workspace: `{${workspaceId}}`,
            include: branch ? branch : undefined,
        });

        const commits = await this.getPaginatedResults(
            bitbucketAPI,
            initialResponse,
        );

        const filteredCommits = commits.filter((commit) => {
            let isValid = true;

            if (isValid && startDate) {
                isValid = new Date(commit.date) >= new Date(startDate);
            }
            if (isValid && endDate) {
                isValid = new Date(commit.date) <= new Date(endDate);
            }
            if (isValid && author) {
                const [name] = this.extractUsernameEmail(commit.author);
                isValid = name === author;
            }
            return isValid;
        });

        return filteredCommits;
    }

    async getFilesByPullRequestId(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<FileChange[] | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetails) {
                return null;
            }

            const repo = await this.getRepoById(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const pr = await bitbucketAPI.pullrequests
                .get({
                    pull_request_id: prNumber,
                    repo_slug: `{${repo.id}}`,
                    workspace: `{${repo.workspaceId}}`,
                })
                .then((res) => res.data);

            const prFiles = await bitbucketAPI.pullrequests
                .getDiffStat({
                    pull_request_id: prNumber,
                    repo_slug: `{${repo.id}}`,
                    workspace: `{${repo.workspaceId}}`,
                })
                .then((res) =>
                    this.getPaginatedResults<Schema.Diffstat>(
                        bitbucketAPI,
                        res,
                    ),
                );

            const prFilesWithDiffAndContents = await Promise.all(
                prFiles
                    .filter((file) => file.new?.path || file.old?.path)
                    .map(async (file) => {
                        const isRemoved = file.status === 'removed';
                        const pathForContent = isRemoved
                            ? file.old?.path
                            : (file.new?.path ?? file.old?.path);
                        const commitForContent = isRemoved
                            ? pr.destination?.commit?.hash
                            : pr.source?.commit?.hash;

                        const contents =
                            pathForContent && commitForContent
                                ? await bitbucketAPI.source
                                      .read({
                                          repo_slug: `{${repo.id}}`,
                                          workspace: `{${repo.workspaceId}}`,
                                          commit: commitForContent,
                                          path: pathForContent,
                                      })
                                      .then((res) => res.data as string)
                                      .catch(() => null)
                                : null;

                        const pathForDiff = isRemoved
                            ? file.old?.path
                            : (file.new?.path ?? file.old?.path);

                        const diff = pathForDiff
                            ? await bitbucketAPI.commits
                                  .getDiff({
                                      repo_slug: `{${repo.id}}`,
                                      workspace: `{${repo.workspaceId}}`,
                                      spec: `${pr.source?.commit?.hash}..${pr.destination?.commit?.hash}`,
                                      path: pathForDiff,
                                  })
                                  .then((res) =>
                                      this.convertDiff(res.data as string),
                                  )
                                  .catch(() => null)
                            : null;

                        return {
                            ...file,
                            contents,
                            diff,
                        };
                    }),
            );

            return prFilesWithDiffAndContents.map((file) => ({
                filename: file.new?.path ?? file.old?.path,
                sha: pr.source?.commit?.hash,
                status: file.status,
                additions: file.lines_added,
                deletions: file.lines_removed,
                changes: file.lines_added + file.lines_removed,
                patch: file.diff,
                blob_url: null,
                content: file.contents,
                contents_url: null,
                raw_url: null,
            }));
        } catch (error) {
            this.logger.error({
                message: `Error to get files by pull request id: ${params?.prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService getFilesByPullRequestId',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async getChangedFilesSinceLastCommit(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        lastCommit: any;
    }): Promise<FileChange[] | null> {
        const { organizationAndTeamData, repository, prNumber, lastCommit } =
            params;

        try {
            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!bitbucketAuthDetails) return null;

            const repo = await this.getRepoById(
                organizationAndTeamData,
                repository.id,
            );
            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            // 🔍 Pega o estado atual do PR
            const pr = await bitbucketAPI.pullrequests
                .get({
                    pull_request_id: prNumber,
                    repo_slug: `{${repo.id}}`,
                    workspace: `{${repo.workspaceId}}`,
                })
                .then((res) => res.data);

            // 📄 Lista todos os arquivos tocados no PR até agora
            const allFilesInPR = await bitbucketAPI.pullrequests
                .getDiffStat({
                    pull_request_id: prNumber,
                    repo_slug: `{${repo.id}}`,
                    workspace: `{${repo.workspaceId}}`,
                })
                .then((res) =>
                    this.getPaginatedResults<Schema.Diffstat>(
                        bitbucketAPI,
                        res,
                    ),
                );

            // ⚙️ Processa apenas arquivos que realmente mudaram desde o último commit
            const changedFiles = await Promise.all(
                allFilesInPR.map(async (file) => {
                    const path = file.new?.path;
                    if (!path) {
                        return null;
                    }

                    const diff = await bitbucketAPI.commits
                        .getDiff({
                            repo_slug: `{${repo.id}}`,
                            workspace: `{${repo.workspaceId}}`,
                            spec: `${pr.source?.commit?.hash}..${lastCommit.sha}`,
                            path,
                        })
                        .then((res) => res.data as string);

                    if (!diff?.trim()) {
                        return null;
                    }

                    const content = await bitbucketAPI.source
                        .read({
                            repo_slug: `{${repo.id}}`,
                            workspace: `{${repo.workspaceId}}`,
                            commit: pr.source?.commit?.hash,
                            path,
                        })
                        .then((res) => res.data as string);

                    return {
                        filename: path,
                        sha: pr.source?.commit?.hash,
                        status: file.status,
                        additions: file.lines_added,
                        deletions: file.lines_removed,
                        changes: file.lines_added + file.lines_removed,
                        patch: diff,
                        content,
                        blob_url: null,
                        contents_url: null,
                        raw_url: null,
                    };
                }),
            );

            return changedFiles.filter(Boolean);
        } catch (error) {
            this.logger.error({
                message:
                    'Error to get incremental changed files since last commit',
                context: BitbucketService.name,
                serviceName: 'getIncrementalChangedFilesSinceLastCommit',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    formatCodeBlock(language: string, code: string) {
        return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    private formatBodyForBitbucket(lineComment: any, repository: any) {
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

        const severityText = lineComment?.suggestion
            ? lineComment.suggestion.severity
            : '';
        const labelText = lineComment?.suggestion
            ? lineComment.suggestion.label
            : '';

        const header = `\`kody|code-review\` \`${labelText}\` \`severity-level|${severityText}\`\n\n`;

        const thumbsUpBlock = `\`\`\`\n👍\n\`\`\`\n`;
        const thumbsDownBlock = `\`\`\`\n👎\n\`\`\`\n`;

        const footer = `Was this suggestion helpful? reply with 👍 or 👎 to help Kody learn from this interaction.\n`;

        return [
            header,
            suggestionContent,
            actionStatement,
            codeBlock,
            footer,
            thumbsUpBlock,
            thumbsDownBlock,
        ]
            .join('\n')
            .trim();
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
                commit,
                language,
            } = params;

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetails) {
                return null;
            }
            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const bodyFormatted = this.formatBodyForBitbucket(
                lineComment,
                repository,
            );

            // added ts-ignore because _body expects a type property but Bitbucket rejects it
            const comment = await bitbucketAPI.pullrequests
                .createComment({
                    pull_request_id: prNumber,
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    // @ts-ignore
                    _body: {
                        content: {
                            raw: bodyFormatted,
                        },
                        inline: {
                            path: lineComment?.path,
                            to: this.sanitizeLine(
                                params.lineComment.start_line ??
                                    params.lineComment.line,
                            ),
                        },
                    },
                })
                .then((res) => res.data);

            this.logger.log({
                message: `Created line comment for PR#${prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService createReviewComment',
                metadata: {
                    params,
                },
            });

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error to create review comment',
                context: BitbucketService.name,
                serviceName: 'BitbucketService createReviewComment',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    private sanitizeLine(line: string | number): number {
        return typeof line === 'string' ? parseInt(line, 10) : line;
    }

    async createCommentInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<IRepository>;
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetails) {
                return null;
            }

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            // added ts-ignore because _body expects a type property but Bitbucket rejects it
            const comment = await bitbucketAPI.pullrequests
                .createComment({
                    pull_request_id: prNumber,
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    // @ts-ignore
                    _body: {
                        content: {
                            raw: overallComment,
                        },
                    },
                })
                .then((res) => res.data);

            this.logger.log({
                message: `Created line comment for PR#${prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService createReviewComment',
                metadata: {
                    params,
                },
            });

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error to create review comment',
                context: BitbucketService.name,
                serviceName: 'BitbucketService createReviewComment',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetails) {
                return null;
            }

            const repo = await this.getRepoById(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const commits = await bitbucketAPI.repositories.listCommits({
                repo_slug: `{${repo.id}}`,
                workspace: `{${repo.workspaceId}}`,
                pagelen: 1,
                include: pullRequest.head?.ref || pullRequest.base?.ref || '',
            });

            const commit = commits?.data?.values?.[0];

            if (!commit) {
                return null;
            }

            const fileContent = await bitbucketAPI.source
                .read({
                    commit: commit.hash,
                    path: file.filename,
                    repo_slug: `{${repo.id}}`,
                    workspace: `{${repo.workspaceId}}`,
                })
                .then((res) => res.data as string);

            return {
                data: {
                    content: fileContent,
                    encoding: '',
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error to get repository content file',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getRepositoryContentFile',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async getPullRequestByNumber(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
    }): Promise<PullRequest | null> {
        try {
            const { organizationAndTeamData, repository, prNumber } = params;

            const pullRequests = await this.getPullRequests({
                organizationAndTeamData,
            });

            return pullRequests.find((pr) => pr.id === prNumber.toString());
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull request by number',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getPullRequestByNumber',
                error: error,
                metadata: {
                    params,
                },
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetails) {
                return null;
            }

            const repo = await this.getRepoById(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const commits = await bitbucketAPI.pullrequests
                .listCommits({
                    pull_request_id: prNumber,
                    repo_slug: `{${repo.id}}`,
                    workspace: `{${repo.workspaceId}}`,
                })
                .then((res) =>
                    this.getPaginatedResults<Schema.Commit>(bitbucketAPI, res),
                );

            return commits
                .map((commit) => {
                    const [name, email] = this.extractUsernameEmail(
                        commit?.author,
                    );

                    return {
                        sha: commit?.hash,
                        message: commit?.message,
                        created_at: commit?.date,
                        author: {
                            id: this.sanitizeUUID(commit?.author?.user?.uuid),
                            username: commit?.author?.user?.nickname,
                            name,
                            email,
                            date: commit?.date,
                        },
                        parents:
                            commit?.parents
                                ?.map((p) => ({
                                    sha: p?.hash ?? '',
                                }))
                                ?.filter((p) => p.sha) ?? [],
                    };
                })
                .sort(
                    (a, b) =>
                        new Date(a?.created_at).getTime() -
                        new Date(b?.created_at).getTime(),
                );
        } catch (error) {
            this.logger.error({
                message:
                    'Error to get commits for pull request for code review',
                context: BitbucketService.name,
                serviceName:
                    'BitbucketService getCommitsForPullRequestForCodeReview',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async createIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        body: any;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, body } =
                params;

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            // added ts-ignore because _body expects a type property but Bitbucket rejects it
            const comment = await bitbucketAPI.pullrequests
                .createComment({
                    pull_request_id: prNumber,
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    // @ts-ignore
                    _body: {
                        content: {
                            raw: body,
                        },
                    },
                })
                .then((res) => res.data);

            this.logger.log({
                message: `Created issue comment for PR#${prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService createIssueComment',
                metadata: {
                    params,
                },
            });

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error to create issue comment',
                context: BitbucketService.name,
                serviceName: 'BitbucketService createIssueComment',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async createSingleIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        prNumber: number;
        body: string;
    }): Promise<any | null> {
        const { organizationAndTeamData, repository, prNumber, body } = params;

        try {
            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!bitbucketAuthDetails) return null;

            const repo = await this.getRepoById(
                organizationAndTeamData,
                repository.id,
            );
            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const response = await bitbucketAPI.pullrequests.createComment({
                pull_request_id: prNumber,
                repo_slug: `{${repo.id}}`,
                workspace: `{${repo.workspaceId}}`,
                // @ts-ignore
                _body: {
                    content: {
                        raw: body,
                    },
                },
            });

            const commentData = response?.data;

            if (!commentData?.id) {
                throw new Error(`Failed to create comment in PR#${prNumber}`);
            }
            this.logger.log({
                message: `Created issue comment for PR#${prNumber}`,
                context: this.createSingleIssueComment.name,
                metadata: { params },
            });

            return {
                id: commentData.id,
                threadId: commentData.id,
                content: commentData.content?.raw,
                createdAt: commentData.created_on,
                author: {
                    id: commentData.user?.uuid,
                    username: commentData.user?.nickname,
                    name: commentData.user?.display_name,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error creating single issue comment on Bitbucket',
                context: this.createSingleIssueComment.name,
                error,
                metadata: { params },
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            // added ts-ignore because _body expects a type property but Bitbucket rejects it
            const comment = await bitbucketAPI.pullrequests
                .updateComment({
                    comment_id: commentId,
                    pull_request_id: prNumber,
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    // @ts-ignore
                    _body: {
                        content: {
                            raw: body,
                        },
                    },
                })
                .then((res) => res.data);

            this.logger.log({
                message: `Updated issue comment for PR#${prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService updateIssueComment',
                metadata: {
                    params,
                },
            });

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error to update issue comment',
                context: BitbucketService.name,
                serviceName: 'BitbucketService updateIssueComment',
                error: error,
                metadata: {
                    params,
                },
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const resolvedComment =
                await bitbucketAPI.pullrequests.resolveComment({
                    comment_id: commentId,
                    pull_request_id: prNumber,
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                });
            return resolvedComment.data;
        } catch (error) {
            this.logger.error({
                message: 'Error marking review comment as resolved',
                context: BitbucketService.name,
                serviceName: 'BitbucketService markReviewCommentAsResolved',
                error: error,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(
                'Failed to mark discussion as resolved for merge request',
            );
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
                context: BitbucketService.name,
                serviceName:
                    'BitbucketService findTeamAndOrganizationIdByConfigKey',
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async getDefaultBranch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<string> {
        try {
            const { organizationAndTeamData, repository } = params;

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const repo = await bitbucketAPI.repositories
                .get({
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                })
                .then((res) => res.data);

            return repo?.mainbranch?.name;
        } catch (error) {
            this.logger.error({
                message: 'Error to get default branch',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getDefaultBranch',
                error: error,
                metadata: {
                    params,
                },
            });
            return '';
        }
    }

    async getPullRequestReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: any;
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, filters } = params;

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                filters.repository.id,
            );

            if (!workspace) {
                return null;
            }

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            if (!bitbucketAPI) {
                return null;
            }
            const comments = await bitbucketAPI.pullrequests
                .listComments({
                    pull_request_id: filters.pullRequestNumber,
                    repo_slug: `{${filters.repository.id}}`,
                    workspace: `{${workspace}}`,
                    pagelen: 50,
                })
                .then((res) => this.getPaginatedResults(bitbucketAPI, res));

            // Adds a replies field to each comment.
            const commentMap = comments.reduce((acc, comment) => {
                // Initialize the replies field and map the comment by ID
                comment.replies = [];
                acc[comment.id] = comment;

                // If the comment has a parent, add it to the parent's replies array
                if (comment.parent) {
                    const parentId = comment.parent.id;
                    if (acc[parentId]) {
                        acc[parentId].replies.push(comment);
                    }
                }

                return acc;
            }, {});

            const organizedComments: any = Object.values(commentMap);

            return organizedComments
                .map((comment) => ({
                    id: comment?.id,
                    body: comment?.content?.raw,
                    createdAt: comment?.created_on,
                    originalCommit: comment?.pullrequest?.source?.commit?.hash,
                    parent: comment?.parent, // present if the comment is a replies to another comment.
                    replies: comment?.replies,
                    author: {
                        id: this.sanitizeUUID(comment?.user?.uuid),
                        username: comment?.user?.display_name,
                        name: comment?.user?.display_name,
                    },
                }))
                .sort(
                    (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                );
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull request review comment',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getPullRequestReviewComment',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            // added ts-ignore because parent expects a type property but Bitbucket rejects it
            const res = await bitbucketAPI.pullrequests.createComment({
                pull_request_id: prNumber,
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
                _body: {
                    content: {
                        raw: body,
                    },
                    // @ts-ignore
                    parent: {
                        id: inReplyToId,
                    },
                },
            });

            return res.data;
        } catch (error) {
            this.logger.error({
                message: 'Error to create response to comment',
                context: BitbucketService.name,
                serviceName: 'BitbucketService createResponseToComment',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            // added ts-ignore because _body expects a type property but Bitbucket rejects it
            await bitbucketAPI.pullrequests.update({
                pull_request_id: prNumber,
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
                // @ts-ignore
                _body: {
                    summary: {
                        raw: summary,
                    },
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error to update description in pull request #${params.prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService updateDescriptionInPullRequest',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async getLanguageRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository } = params;

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const repo = await bitbucketAPI.repositories
                .get({
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                })
                .then((res) => res.data);

            return repo.language ?? null;
        } catch (error) {
            this.logger.error({
                message: `Error to get language repository`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService getLanguageRepository',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async createAuthIntegration(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        authMode: AuthMode;
        code?: string;
        token?: string;
        username?: string;
        email?: string;
    }): Promise<{ success: boolean; status?: CreateAuthIntegrationStatus }> {
        try {
            let res: {
                success: boolean;
                status?: CreateAuthIntegrationStatus;
            } = { success: true, status: CreateAuthIntegrationStatus.SUCCESS };
            if (params && params?.authMode === AuthMode.OAUTH) {
                throw new Error(
                    'Authenticating on Bitbucket via OAuth not implemented',
                );
            } else if (
                params &&
                params?.authMode === AuthMode.TOKEN &&
                params.token
            ) {
                res = await this.authenticateWithToken({
                    organizationAndTeamData: params.organizationAndTeamData,
                    token: params.token,
                    username: params.username,
                    email: params.email,
                });
            }

            this.mcpManagerService?.createKodusMCPIntegration(
                params.organizationAndTeamData.organizationId,
            );

            return res;
        } catch (err) {
            this.logger.error({
                message: 'Error to create auth integration',
                context: BitbucketService.name,
                serviceName: 'BitbucketService createAuthIntegration',
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async updateAuthIntegration(params: any): Promise<any> {
        try {
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
        } catch (err) {
            this.logger.error({
                message: 'Error to update auth integration',
                context: BitbucketService.name,
                serviceName: 'BitbucketService updateAuthIntegration',
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(err);
        }
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
        } catch (error) {
            this.logger.error({
                message: 'Error to create or update integration config',
                context: BitbucketService.name,
                serviceName: 'BitbucketService createOrUpdateIntegrationConfig',
                error: error,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(error.message);
        }
    }

    async createWebhook(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        try {
            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            const webhookUrl =
                process.env.GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK;

            for (const repo of repositories) {
                const existingHooks = await bitbucketAPI.webhooks
                    .listForRepo({
                        repo_slug: `{${repo.id}}`,
                        workspace: `{${repo.workspaceId}}`,
                        pagelen: 50,
                    })
                    .then((res) => this.getPaginatedResults(bitbucketAPI, res));

                const hookExists = existingHooks.some(
                    (hook) => hook.url === webhookUrl,
                );

                if (!hookExists) {
                    await bitbucketAPI.webhooks.create({
                        repo_slug: `{${repo.id}}`,
                        workspace: `{${repo.workspaceId}}`,
                        _body: {
                            description: 'Kodus Webhook',
                            url: webhookUrl,
                            active: true,
                            events: [
                                'pullrequest:created',
                                'pullrequest:updated',
                                'pullrequest:rejected',
                                'pullrequest:fulfilled',
                                'pullrequest:comment_created',
                            ],
                        },
                    });
                    this.logger.log({
                        message: 'Webhook created successfully',
                        context: BitbucketService.name,
                        serviceName:
                            'BitbucketService createMergeRequestWebhook',
                        metadata: {
                            organizationAndTeamData,
                        },
                    });
                } else {
                    this.logger.log({
                        message: 'Webhook already exists',
                        context: BitbucketService.name,
                        serviceName:
                            'BitbucketService createMergeRequestWebhook',
                        metadata: {
                            organizationAndTeamData,
                        },
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error to create webhook',
                context: BitbucketService.name,
                serviceName: 'BitbucketService createMergeRequestWebhook',
                error: error,
                metadata: {
                    organizationAndTeamData,
                },
            });
            throw error;
        }
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
                message: 'Error to get auth details',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getAuthDetails',
                error: err,
                metadata: {
                    organizationAndTeamData,
                },
            });
        }
    }

    private instanceBitbucketApi(bitbucketAuthDetail: BitbucketAuthDetail) {
        try {
            const bitbucketAPI = new Bitbucket({
                auth: {
                    username:
                        bitbucketAuthDetail.email ??
                        bitbucketAuthDetail.username,
                    password: decrypt(bitbucketAuthDetail.appPassword),
                },
            });

            return bitbucketAPI;
        } catch (err) {
            this.logger.error({
                message: 'Error to instance Bitbucket API',
                context: BitbucketService.name,
                serviceName: 'BitbucketService instanceBitbucketApi',
                error: err,
                metadata: {
                    bitbucketAuthDetail,
                },
            });
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
                context: BitbucketService.name,
                serviceName:
                    'BitbucketService findOneByOrganizationAndTeamDataAndConfigKey',
                error: err,
                metadata: {
                    organizationAndTeamData,
                    configKey,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async authenticateWithToken(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
        token: string;
        email?: string;
    }): Promise<{ success: boolean; status?: CreateAuthIntegrationStatus }> {
        try {
            const { organizationAndTeamData, token, username, email } = params;

            const bitbucketAPI = new Bitbucket({
                auth: {
                    username: email ?? username,
                    password: token,
                },
            });

            const testResponse = await bitbucketAPI.user.get({});

            if (
                !testResponse ||
                testResponse.status === 401 ||
                !testResponse.data
            ) {
                throw new Error('Bitbucket failed to validate the PAT.');
            }

            const checkRepos = await this.checkRepositoryPermissions({
                bitbucketAPI,
            });
            if (!checkRepos.success) {
                return checkRepos;
            }

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.BITBUCKET,
            });

            const authDetails: BitbucketAuthDetail = {
                username: username,
                appPassword: encrypt(token),
                authMode: AuthMode.TOKEN,
                email: email,
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
                context: BitbucketService.name,
                serviceName: 'BitbucketService authenticateWithToken',
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(
                'Error authenticating with Bitbucket PAT.',
            );
        }
    }

    private async checkRepositoryPermissions(params: {
        bitbucketAPI: APIClient;
    }) {
        try {
            const { bitbucketAPI } = params;

            const workspaces = await bitbucketAPI.workspaces
                .getWorkspaces({})
                .then((res) => res.data.values);

            const workspace = workspaces[0];

            const repositories = await bitbucketAPI.repositories
                .list({
                    workspace: workspace.uuid,
                })
                .then((res) => res.data.values);

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
                context: BitbucketService.name,
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
        authDetails: BitbucketAuthDetail,
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

    private async getWorkspaceFromRepository(
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

        return repo?.workspaceId || null;
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

    async mergePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }) {
        try {
            const { organizationAndTeamData, prNumber, repository } = params;

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                return null;
            }

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            await bitbucketAPI.pullrequests.merge({
                pull_request_id: prNumber,
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
            });

            this.logger.log({
                message: `Merged pull request #${prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService mergePullRequest',
                metadata: {
                    params,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error to merge pull request #${params.prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService mergePullRequest',
                error: error,
                metadata: {
                    params,
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
                        'Missing parameters to get review status by pull request',
                    context: BitbucketService.name,
                    serviceName:
                        'BitbucketService getReviewStatusByPullRequest',
                    metadata: { params },
                });
                return null;
            }

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetails) {
                this.logger.warn({
                    message: 'Bitbucket auth details not found',
                    context: this.getReviewStatusByPullRequest.name,
                    metadata: { organizationAndTeamData },
                });
                return null;
            }

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                return null;
            }

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const [currentUserRes, activitiesRes] = await Promise.all([
                bitbucketAPI.users.getAuthedUser({}),
                bitbucketAPI.pullrequests.listActivities({
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    pull_request_id: prNumber,
                }),
            ]);

            type BitbucketActivity = {
                approval?: { user?: { uuid?: string } };
                changes_requested?: { user?: { uuid?: string } };
            };

            const userUuid = currentUserRes?.data?.uuid;
            const activities =
                await this.getPaginatedResults<BitbucketActivity>(
                    bitbucketAPI,
                    activitiesRes,
                );

            let state: PullRequestReviewState | null = null;
            for (const activity of activities) {
                if (activity.approval?.user?.uuid === userUuid) {
                    state = PullRequestReviewState.APPROVED;
                    break;
                }

                if (activity.changes_requested?.user?.uuid === userUuid) {
                    state = PullRequestReviewState.CHANGES_REQUESTED;
                    break;
                }
            }

            return state;
        } catch (error) {
            this.logger.error({
                message: `Error fetching review status for PR #${prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService getReviewStatusByPullRequest',
                error: error,
                metadata: { params },
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
            const { organizationAndTeamData, prNumber, repository } = params;

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                return null;
            }

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            if (!bitbucketAuthDetails) {
                this.logger.warn({
                    message: 'Bitbucket auth details not found',
                    context: this.checkIfPullRequestShouldBeApproved.name,
                    metadata: { organizationAndTeamData },
                });
                return null;
            }

            const currentUser = (await bitbucketAPI.users.getAuthedUser({}))
                .data;

            const activities = await bitbucketAPI.pullrequests
                .listActivities({
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    pull_request_id: prNumber,
                    pagelen: 50,
                })
                .then((res) => this.getPaginatedResults(bitbucketAPI, res));

            const isApprovedByCurrentUser = activities.find(
                (activity: any) =>
                    activity.approval?.user?.uuid === currentUser?.uuid,
            );

            if (isApprovedByCurrentUser) {
                return null;
            }

            await this.approvePullRequest({
                organizationAndTeamData,
                prNumber,
                repository,
            });
        } catch (error) {
            this.logger.error({
                message: `Error to approve pull request #${params.prNumber}`,
                context: BitbucketService.name,
                serviceName:
                    'BitbucketService checkIfPullRequestShouldBeApproved',
                error: error,
                metadata: {
                    params,
                },
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                return null;
            }

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            await bitbucketAPI.pullrequests.createApproval({
                pull_request_id: prNumber,
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
            });

            this.logger.log({
                message: `Approved pull request #${prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService approvePullRequest',
                metadata: {
                    params,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error to approve pull request #${params.prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService approvePullRequest',
                error: error,
                metadata: {
                    params,
                },
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                return null;
            }

            const listOfCriticalIssues =
                this.getListOfCriticalIssues(criticalComments);

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            await bitbucketAPI.pullrequests.addChangeRequest({
                pull_request_id: prNumber,
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
            });

            const title =
                '# Found critical issues please review the requested changes';

            const bodyFormatted = `${title}\n\n${listOfCriticalIssues}`;

            await this.createCommentInPullRequest({
                overallComment: bodyFormatted,
                organizationAndTeamData,
                prNumber,
                repository,
            });

            this.logger.log({
                message: `Changed status to requested changes on pull request #${prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService requestChangesPullRequest',
                metadata: {
                    params,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error to change status to requested changes on pull request #${params.prNumber}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService requestChangesPullRequest',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    getListOfCriticalIssues(criticalComments: CommentResult[]): string {
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const comments = await bitbucketAPI.pullrequests
                .listComments({
                    pull_request_id: prNumber,
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    pagelen: 50,
                })
                .then((res) => this.getPaginatedResults(bitbucketAPI, res));

            return comments.map((comment) => ({
                id: comment?.id,
                body: comment?.content?.raw,
                createdAt: comment?.created_on,
                originalCommit: comment?.pullrequest?.source?.commit?.hash,
                author: {
                    id: this.sanitizeUUID(comment?.user?.uuid),
                    username: comment?.user?.display_name,
                    name: comment?.user?.display_name,
                },
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error to get all comments in pull request',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getAllCommentsInPullRequest',
                error: error.message,
                metadata: params,
            });
            return [];
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            let queryString = '';
            if (filters?.startDate) {
                queryString += `created_on >= "${filters.startDate}"`;
            }
            if (filters?.endDate) {
                queryString += `${
                    queryString ? ' AND ' : ''
                }created_on <= "${filters.endDate}"`;
            }

            const listParams: any = {
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
                fields: '+values.participants,+values.reviewers,+values.draft',
                pagelen: 50,
            };

            if (queryString) {
                listParams.q = queryString;
            }

            const pullRequests = await bitbucketAPI.pullrequests
                .list(listParams)
                .then((res) => {
                    return this.getPaginatedResultsWithLimit(
                        bitbucketAPI,
                        res,
                        100,
                    );
                });

            return pullRequests.map((pr) =>
                this.transformPullRequest(pr, organizationAndTeamData),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests by repository',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getPullRequestsByRepository',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any | null> {
        const { organizationAndTeamData, username } = params;

        if (!username) {
            return null;
        }

        const cacheKey = `bitbucket-user-${organizationAndTeamData.organizationId}-${username}`;

        const cached = await this.cacheService.getFromCache<any>(cacheKey);
        if (cached !== null) {
            this.logger.debug({
                message: `User data retrieved from cache`,
                context: BitbucketService.name,
                metadata: {
                    username,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            return cached;
        }

        try {
            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const user = await bitbucketAPI.users
                .get({
                    selected_user: username,
                    fields: '+values.username,+values.email',
                })
                .then((res) => res.data);

            const userData = user ?? null;

            await this.cacheService.addToCache(
                cacheKey,
                userData,
                this.USER_CACHE_TTL,
            );

            return userData;
        } catch (error: any) {
            if (error?.response?.status === 404) {
                this.logger.warn({
                    message: `Bitbucket user not found: ${username}`,
                    context: BitbucketService.name,
                    metadata: { username, organizationAndTeamData },
                });

                // Cache null result to avoid repeated 404 calls
                await this.cacheService.addToCache(
                    cacheKey,
                    null,
                    this.USER_CACHE_TTL,
                );

                return null;
            }

            this.logger.error({
                message: `Error retrieving user by username`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService getUserByUsername',
                error,
                metadata: {
                    username,
                    organizationAndTeamData,
                },
            });
            return null;
        }
    }

    async getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null> {
        try {
            const bitbucketAuthDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                return null;
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);
            const user = await bitbucketAPI.user
                .get({})
                .then((res) => res.data);

            if (!user) {
                return null;
            }

            const sanitizedUuid =
                user?.uuid && this.sanitizeUUID(String(user.uuid));
            const sanitizedId = user?.id && this.sanitizeUUID(String(user.id));
            const sanitizedAccountId =
                user?.account_id && this.sanitizeUUID(String(user.account_id));

            return {
                ...user,
                ...(sanitizedUuid && { uuid: sanitizedUuid }),
                ...(sanitizedId && { id: sanitizedId }),
                ...(sanitizedAccountId && { account_id: sanitizedAccountId }),
            };
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving current Bitbucket user',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getCurrentUser',
                error,
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

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                return null;
            }

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                return null;
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const comments = await bitbucketAPI.pullrequests
                .listComments({
                    repo_slug: `{${repository.id}}`,
                    workspace: `{${workspace}}`,
                    pull_request_id: prNumber,
                    fields: '+values.resolution.type,+values.resolution.+values.id,+values.pullrequest',
                    pagelen: 50,
                })
                .then((res) => this.getPaginatedResults(bitbucketAPI, res));

            return comments
                .filter(
                    (comment) =>
                        comment?.deleted !== true &&
                        !hasKodyMarker(comment?.content?.raw),
                )
                .map((comment) => {
                    const mappedComment: PullRequestReviewComment = {
                        id: comment?.id,
                        threadId: null, // Bitbucket comments are resolved by id,so no threadId necessary
                        body: comment?.content?.raw ?? '',
                        createdAt: comment?.created_on,
                        updatedAt: comment?.updated_on,
                        isResolved: comment.resolution ? true : false,
                        author: {
                            id: this.sanitizeUUID(comment?.user?.uuid) ?? '',
                            username: comment?.user?.display_name ?? '',
                            name: comment?.user?.display_name ?? '',
                        },
                    };
                    return mappedComment;
                })
                .sort(
                    (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                );
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull requests with files',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getPullRequestReviewComments',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    async countReactions(params: { comments: any[]; pr: any }): Promise<any[]> {
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
                        const userId = reply.user.uuid;
                        const replyBody = reply.content.raw;

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
                            replyBody?.includes(thumbsUpText) &&
                            !userReaction.thumbsUp
                        ) {
                            comment.thumbsUp++;
                            userReaction.thumbsUp = true;
                        }

                        // Check for thumbs down reaction
                        if (
                            replyBody?.includes(thumbsDownText) &&
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
                            id: comment.id,
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
                context: BitbucketService.name,
                serviceName: 'BitbucketService countReactions',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    /**
    this function is used to get all the results from a paginated response
    it will keep making requests to the next page until there are no more pages

    the type `T` is the type of the values that are paginated, most of the time
    this can be inferred from the response type and there's no need to specify it
    manually, but in some cases it might be necessary to specify it manually
    (e.g `getPaginatedResults<Schema.Diffstat>(bitbucketAPI, res)`)
    */
    private async getPaginatedResults<T>(
        bitbucketAPI: APIClient,
        response: BitbucketResponse<{ values?: T[] }>,
    ): Promise<T[]> {
        if (!response.data.values || !Array.isArray(response.data.values)) {
            return [];
        }

        let allResults = [...response.data.values];
        let currentResults = response.data;

        while (bitbucketAPI.hasNextPage(currentResults)) {
            currentResults = (await bitbucketAPI.getNextPage(currentResults))
                .data;

            if (currentResults.values && Array.isArray(currentResults.values)) {
                allResults = allResults.concat(currentResults.values);
            }
        }

        return allResults;
    }

    /**
     * Retrieves paginated results with a limit for optimization.
     * Used specifically for scenarios where we only need recent data (like authors).
     * @param bitbucketAPI - The Bitbucket API client.
     * @param response - The initial response from the API.
     * @param limit - Maximum number of items to fetch.
     * @returns A promise that resolves to an array of items (limited).
     */
    private async getPaginatedResultsWithLimit<T>(
        bitbucketAPI: APIClient,
        response: BitbucketResponse<{ values?: T[] }>,
        limit: number = 100,
    ): Promise<T[]> {
        if (!response.data.values || !Array.isArray(response.data.values)) {
            return [];
        }

        let allResults = [...response.data.values];
        let currentResults = response.data;

        // Early termination if we already have enough results
        if (allResults.length >= limit) {
            return allResults.slice(0, limit);
        }

        while (
            bitbucketAPI.hasNextPage(currentResults) &&
            allResults.length < limit
        ) {
            currentResults = (await bitbucketAPI.getNextPage(currentResults))
                .data;

            if (currentResults.values && Array.isArray(currentResults.values)) {
                allResults = allResults.concat(currentResults.values);
            }
        }

        // Return only up to the limit
        return allResults.slice(0, limit);
    }

    /** Bitbucket's API returns IDs with curly braces around them (e.g. "{123}").
    This function removes the curly braces. */
    private sanitizeUUID(id: string): string {
        return id?.replace(/[{}]/g, '');
    }

    /** Extracts the username and email from a string with the following format: "Name <Email>" */
    private extractUsernameEmail(author: Schema.Author) {
        const raw = author?.raw || '';

        // (.+) = capture group #1, anything before the '<'
        // ([^<]+) = capture group #2, anything inside the '<' and '>'
        // #1<#2> = capture group #0, the entire string
        const regex = /(.+)<([^>]+)/;

        const match = raw.match(regex);

        const username = match[1] || author?.user?.display_name || raw;
        const email = match ? match[2] : raw;

        return [username.trim(), email.trim()];
    }

    private convertDiff(diff: string) {
        return diff.split('\n').slice(4).join('\n');
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

            const bitbucketAPI = this.instanceBitbucketApi(authDetails);

            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            if (!repositories?.length) {
                return false;
            }

            const targetRepo = repositories.find(
                (repo) =>
                    this.sanitizeUUID(repo.id) ===
                    this.sanitizeUUID(repositoryId),
            );

            if (!targetRepo?.workspaceId) {
                return false;
            }

            const webhookUrl =
                this.configService.get<string>(
                    'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
                ) ?? process.env.GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK;

            if (!webhookUrl) {
                return false;
            }

            const existingHooks = await bitbucketAPI.webhooks
                .listForRepo({
                    repo_slug: `{${this.sanitizeUUID(targetRepo.id)}}`,
                    workspace: `{${this.sanitizeUUID(targetRepo.workspaceId)}}`,
                    pagelen: 50,
                })
                .then((res) => this.getPaginatedResults(bitbucketAPI, res));

            return existingHooks.some(
                (hook: any) =>
                    hook?.url === webhookUrl && hook?.active !== false,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error verifying Bitbucket webhook status',
                context: BitbucketService.name,
                serviceName: 'BitbucketService isWebhookActive',
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
        const bitbucketAPI = this.instanceBitbucketApi(authDetails);

        if (authDetails.authMode === AuthMode.TOKEN) {
            const repositories = <Repositories[]>(
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                )
            );

            const webhookUrl = this.configService.get<string>(
                'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
            );

            if (!webhookUrl) {
                this.logger.error({
                    message: 'Bitbucket webhook URL not found',
                    context: BitbucketService.name,
                });
                return;
            }

            for (const repo of repositories) {
                try {
                    const existingHooks = await bitbucketAPI.webhooks
                        .listForRepo({
                            repo_slug: `{${repo.id}}`,
                            workspace: `{${repo.workspaceId}}`,
                            pagelen: 50,
                        })
                        .then((res) =>
                            this.getPaginatedResults(bitbucketAPI, res),
                        );

                    const webhook = existingHooks.find(
                        (hook) => hook.url === webhookUrl,
                    );

                    if (webhook) {
                        await bitbucketAPI.repositories.deleteWebhook({
                            repo_slug: `{${repo.id}}`,
                            workspace: `{${repo.workspaceId}}`,
                            uid: webhook.uuid,
                        });

                        this.logger.log({
                            message: `Webhook deleted successfully for repository ${repo.name}`,
                            context: this.deleteWebhook.name,
                            metadata: {
                                repository: repo.name,
                                workspace: repo.workspaceId,
                                organizationAndTeamData:
                                    params.organizationAndTeamData,
                            },
                        });
                    }
                } catch (error) {
                    this.logger.error({
                        message: `Error deleting Bitbucket webhook for repository ${repo.name}`,
                        context: this.deleteWebhook.name,
                        error: error,
                        metadata: {
                            repository: repo.name,
                            workspace: repo.workspaceId,
                            organizationAndTeamData:
                                params.organizationAndTeamData,
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
    }): Promise<string> {
        const {
            suggestion,
            repository,
            includeHeader = true,
            includeFooter = true,
        } = params;

        let commentBody = '';

        // HEADER - Badges (formato Bitbucket)
        if (includeHeader) {
            const severityText = suggestion?.severity || '';
            const labelText = suggestion?.label || '';

            commentBody += `\`kody|code-review\` \`${labelText}\` \`severity-level|${severityText}\`\n\n\n`;
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

        // FOOTER - Interação/Feedback (formato Bitbucket)
        if (includeFooter) {
            commentBody +=
                'Was this suggestion helpful? reply with 👍 or 👎 to help Kody learn from this interaction.\n\n';
            commentBody += `\`\`\`\n👍\n\`\`\`\n\n\`\`\`\n👎\n\`\`\``;
        }

        return Promise.resolve(commentBody.trim());
    }

    private async fetchDirectoryItems(
        bitbucketAuthDetails: any,
        workspace: string,
        repositoryId: string,
        directoryPath?: string,
    ): Promise<any[]> {
        try {
            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);
            const allItems: any[] = [];
            let hasNext = true;
            let nextPageUrl: string | null = null;
            let pageCount = 0;

            while (hasNext) {
                pageCount++;

                let response: any;

                try {
                    if (directoryPath) {
                        // Para um path específico - usar source.read
                        response = await bitbucketAPI.source.read({
                            workspace: `{${workspace}}`,
                            repo_slug: `{${repositoryId}}`,
                            path: directoryPath,
                            pagelen: 50,
                            commit: 'HEAD',
                        });
                    } else {
                        // Para raiz - usar source.readRoot
                        response = await bitbucketAPI.source.readRoot({
                            workspace: `{${workspace}}`,
                            repo_slug: `{${repositoryId}}`,
                            pagelen: 50,
                        });
                    }
                } catch (apiError) {
                    throw apiError;
                }

                const items = response.data?.values || [];

                allItems.push(...items);

                nextPageUrl = response.data?.next || null;
                hasNext = !!nextPageUrl;
            }

            return allItems;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching directory items from Bitbucket',
                context: 'fetchDirectoryItems',
                error: error,
                metadata: { workspace, repositoryId, directoryPath },
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetails) {
                return [];
            }

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repositoryId,
            );

            if (!workspace) {
                return [];
            }

            const items = await this.fetchDirectoryItems(
                bitbucketAuthDetails,
                workspace,
                repositoryId,
                directoryPath,
            );

            if (!items || !Array.isArray(items)) {
                return [];
            }

            const directories = items
                .filter((item: any) => {
                    const isDir = item.type === 'commit_directory';
                    return isDir;
                })
                .map((item: any) => {
                    const mapped = {
                        path: item.path,
                        type: 'directory' as const,
                        sha: item.commit?.hash || '',
                        size: undefined,
                        url: item.links?.self?.href || '',
                        hasChildren: true,
                    };
                    return mapped;
                });

            return directories;
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting repository tree by directory from Bitbucket',
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

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!bitbucketAuthDetails) {
                this.logger.error({
                    message: 'Bitbucket auth details not found',
                    context: this.getRepositoryTree.name,
                    metadata: { organizationAndTeamData, repositoryId },
                });
                return [];
            }

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repositoryId,
            );

            if (!workspace) {
                this.logger.error({
                    message:
                        'Workspace not found for Bitbucket repository tree',
                    context: this.getRepositoryTree.name,
                    metadata: { organizationAndTeamData, repositoryId },
                });
                return [];
            }

            // Buscar recursivamente com max_depth - mais eficiente que navegação manual
            const allItems = await this.getRepositoryTreeWithMaxDepth(
                bitbucketAuthDetails,
                workspace,
                repositoryId,
            );

            // Filtrar baseado no treeType
            if (treeType === 'directories') {
                return allItems.filter(
                    (item: any) => item.type === 'directory',
                );
            } else if (treeType === 'files') {
                return allItems.filter((item: any) => item.type === 'file');
            }

            return allItems;
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree from Bitbucket',
                context: this.getRepositoryTree.name,
                error: error,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId: params.repositoryId,
                    treeType: params.treeType,
                },
            });
            return [];
        }
    }

    /**
     * Método principal que usa max_depth através do SDK do Bitbucket (que já cuida da auth)
     * Muito mais eficiente que navegação manual - usa o recurso nativo do Bitbucket API
     */
    private async getRepositoryTreeWithMaxDepth(
        bitbucketAuthDetails: any,
        workspace: string,
        repositoryId: string,
        maxDepth: number = 10, // Evitar timeout, pode ajustar conforme necessário
    ): Promise<any[]> {
        try {
            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);
            const allItems: any[] = [];
            let hasNext = true;
            let nextPageUrl: string | null = null;
            let pageNum = 1;

            while (hasNext) {
                let response: any;

                if (nextPageUrl) {
                    // Usar a URL da próxima página diretamente
                    response = await bitbucketAPI.request({
                        url: nextPageUrl,
                        method: 'GET',
                    });
                } else {
                    // Primeira requisição - usar request direto com query params
                    const queryParams = new URLSearchParams({
                        max_depth: maxDepth.toString(),
                        pagelen: '50',
                        page: pageNum.toString(),
                    });

                    const url = `/repositories/${workspace}/${repositoryId}/src/HEAD/?${queryParams.toString()}`;

                    this.logger.debug({
                        message: `Calling Bitbucket API: ${url}`,
                        context: 'getRepositoryTreeWithMaxDepth',
                        metadata: {
                            workspace,
                            repositoryId,
                            maxDepth,
                            pageNum,
                        },
                    });

                    response = await bitbucketAPI.request({
                        url: url,
                        method: 'GET',
                    });
                }

                const items = response.data?.values || [];

                this.logger.debug({
                    message: `Fetching Bitbucket tree page ${pageNum} - found ${items.length} items`,
                    context: 'getRepositoryTreeWithMaxDepth',
                    metadata: {
                        workspace,
                        repositoryId,
                        maxDepth,
                        pageNum,
                        itemsCount: items.length,
                    },
                });

                for (const item of items) {
                    // Normalizar o formato para ser compatível com GitHub
                    const normalizedItem = {
                        path: item.path,
                        type:
                            item.type === 'commit_directory'
                                ? 'directory'
                                : 'file',
                        sha: item.commit?.hash || '',
                        size: item.size || undefined,
                        url: item.links?.self?.href || '',
                        commit: item.commit, // Manter dados do commit se necessário
                    };

                    allItems.push(normalizedItem);
                }

                // Verificar se há próxima página
                nextPageUrl = response.data?.next || null;
                hasNext = !!nextPageUrl;
                pageNum++;

                // Proteção contra loops infinitos
                if (pageNum > 1000) {
                    this.logger.warn({
                        message:
                            'Too many pages in Bitbucket tree, stopping pagination',
                        context: 'getRepositoryTreeWithMaxDepth',
                        metadata: { workspace, repositoryId, pageNum },
                    });
                    break;
                }
            }

            this.logger.debug({
                message: `Successfully fetched Bitbucket tree with ${allItems.length} items`,
                context: 'getRepositoryTreeWithMaxDepth',
                metadata: {
                    workspace,
                    repositoryId,
                    totalItems: allItems.length,
                    pages: pageNum - 1,
                },
            });

            return allItems;
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree with max_depth',
                context: 'getRepositoryTreeWithMaxDepth',
                error: error,
                metadata: { workspace, repositoryId, maxDepth },
            });

            // Se max_depth falhar (timeout 555), tentar com profundidade menor
            if (
                error instanceof Error &&
                error.message?.includes('555') &&
                maxDepth > 3
            ) {
                this.logger.warn({
                    message: 'Retrying with smaller max_depth due to timeout',
                    context: 'getRepositoryTreeWithMaxDepth',
                    metadata: {
                        workspace,
                        repositoryId,
                        previousMaxDepth: maxDepth,
                        newMaxDepth: 3,
                    },
                });

                return await this.getRepositoryTreeWithMaxDepth(
                    bitbucketAuthDetails,
                    workspace,
                    repositoryId,
                    3, // Tentar com profundidade menor
                );
            }

            // Se der erro, tentar o método recursivo fallback
            this.logger.warn({
                message:
                    'Falling back to recursive method due to max_depth failure',
                context: 'getRepositoryTreeWithMaxDepth',
                metadata: { workspace, repositoryId },
            });

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);
            return await this.getRepositoryTreeRecursiveFallback(
                bitbucketAPI,
                workspace,
                repositoryId,
                '', // currentPath vazio para começar da raiz
                [], // allItems vazio
                undefined, // commitHash será pego da resposta inicial
            );
        }
    }

    private async getRepositoryTreeRecursiveFallback(
        bitbucketAPI: any,
        workspace: string,
        repositoryId: string,
        currentPath: string = '',
        allItems: any[] = [],
        commitHash?: string, // ADICIONADO: commit hash para resolver o erro
    ): Promise<any[]> {
        try {
            let response: any;
            let hasNext = true;
            let currentApiCall: any;

            if (currentPath && commitHash) {
                // Para subdiretórios - usar source.read com commit hash
                currentApiCall = () =>
                    bitbucketAPI.source.read({
                        repo_slug: `{${repositoryId}}`,
                        workspace: `{${workspace}}`,
                        commit: commitHash, // ADICIONADO: resolver o erro "parameter required: 'commit'"
                        path: currentPath,
                        pagelen: 50,
                    });
            } else {
                // Para raiz - usar source.readRoot
                currentApiCall = () =>
                    bitbucketAPI.source.readRoot({
                        repo_slug: `{${repositoryId}}`,
                        workspace: `{${workspace}}`,
                        pagelen: 50,
                    });
            }

            while (hasNext) {
                response = await currentApiCall();
                const items = response.data?.values || [];

                for (const item of items) {
                    // Normalizar o formato do item para ser compatível com o GitHub
                    const normalizedItem = {
                        path: item.path,
                        type:
                            item.type === 'commit_directory'
                                ? 'directory'
                                : 'file',
                        sha: item.commit?.hash || '',
                        size: item.size || undefined,
                        url: item.links?.self?.href || '',
                        commit: item.commit,
                    };

                    allItems.push(normalizedItem);

                    // Se for um diretório, buscar recursivamente
                    if (item.type === 'commit_directory') {
                        const currentCommitHash =
                            commitHash || item.commit?.hash; // Usar o commit do item se não tiver

                        await this.getRepositoryTreeRecursiveFallback(
                            bitbucketAPI,
                            workspace,
                            repositoryId,
                            item.path,
                            allItems,
                            currentCommitHash, // PASSAR o commit hash para subdiretórios
                        );
                    }
                }

                // Verificar se há próxima página no mesmo nível
                const nextUrl = response.data?.next;
                if (nextUrl) {
                    // Usar a URL da próxima página
                    currentApiCall = () =>
                        bitbucketAPI.request({
                            url: nextUrl,
                            method: 'GET',
                        });
                } else {
                    hasNext = false;
                }
            }

            return allItems;
        } catch (error) {
            this.logger.error({
                message: `Error getting repository tree recursively for path: ${currentPath}`,
                context: 'getRepositoryTreeRecursiveFallback',
                error: error,
                metadata: { workspace, repositoryId, currentPath, commitHash },
            });
            return allItems; // Retorna o que já foi coletado até agora
        }
    }

    minimizeComment(_params: {
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
                    message: 'Repository ID is required to get files',
                    context: BitbucketService.name,
                    metadata: { organizationAndTeamData, repository },
                });

                return [];
            }

            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetails) {
                this.logger.warn({
                    message: 'Bitbucket auth details not found',
                    context: BitbucketService.name,
                    metadata: { organizationAndTeamData, repository },
                });

                return [];
            }

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                this.logger.warn({
                    message: 'Workspace not found for repository',
                    context: BitbucketService.name,
                    metadata: { organizationAndTeamData, repository },
                });

                return [];
            }

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            let branch = filters?.branch;

            if (!branch || branch.length === 0) {
                branch = await this.getDefaultBranch({
                    organizationAndTeamData,
                    repository,
                });

                if (!branch) {
                    this.logger.warn({
                        message: 'Default branch not found for repository',
                        context: BitbucketService.name,
                        metadata: { organizationAndTeamData, repository },
                    });

                    return [];
                }
            }

            const commitsResponse = await bitbucketAPI.commits.list({
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
                include: branch,
                pagelen: 1,
            });

            const commit = commitsResponse.data.values?.[0];

            if (!commit || !commit.hash) {
                this.logger.warn({
                    message: `No commit found on branch ${branch} for repository ${repository.name}`,
                    context: BitbucketService.name,
                    metadata: { organizationAndTeamData, repository, branch },
                });

                return [];
            }

            const fileResponse = await bitbucketAPI.source.read({
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
                commit: commit?.hash,
                path: '/',
                max_depth: 999,
            });

            const fileTrees = await this.getPaginatedResults(
                bitbucketAPI,
                fileResponse,
            );

            let files = fileTrees
                .filter((file) => file.type === 'commit_file')
                .map((file) => this.transformRepositoryFile(file));

            const { filePatterns, excludePatterns, maxFiles = 1000 } = filters;

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
                context: BitbucketService.name,
                serviceName: 'BitbucketService getRepositoryAllFiles',
                metadata: {
                    params,
                    totalFilesFound: fileTrees.length,
                },
            });

            return filteredFiles;
        } catch (error) {
            this.logger.error({
                message: 'Error to get repository files',
                context: BitbucketService.name,
                serviceName: 'BitbucketService getRepositoryAllFiles',
                error: error,
                metadata: {
                    params,
                },
            });

            return [];
        }
    }

    async updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        commentId: string;
        body: string;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any | null> {
        const {
            organizationAndTeamData,
            commentId,
            body,
            repository,
            prNumber,
        } = params;

        try {
            const bitbucketAuthDetails = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!bitbucketAuthDetails) {
                this.logger.error({
                    message: 'Bitbucket auth details not found',
                    context: BitbucketService.name,
                    serviceName: 'BitbucketService updateResponseToComment',
                    metadata: { organizationAndTeamData, repository, prNumber },
                });
                return null;
            }

            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                this.logger.error({
                    message: 'Workspace not found for repository',
                    context: BitbucketService.name,
                    serviceName: 'BitbucketService updateResponseToComment',
                    metadata: { organizationAndTeamData, repository, prNumber },
                });
                return null;
            }

            const response = await bitbucketAPI.pullrequests.updateComment({
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
                pull_request_id: prNumber,
                comment_id: Number(commentId),
                // @ts-ignore
                _body: {
                    content: {
                        raw: body,
                    },
                },
            });

            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'Error updating response to comment',
                context: BitbucketService.name,
                serviceName: 'BitbucketService updateResponseToComment',
                error: error,
                metadata: {
                    params,
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
                message: 'Error checking if PR is draft',
                context: BitbucketService.name,
                serviceName: 'BitbucketService isDraftPullRequest',
                error: error,
                metadata: {
                    params,
                },
            });
            return false;
        }
    }

    //#region Transformers

    /**
     * Transforms a raw commit from the Bitbucket API into the standard Commit interface.
     * @param rawCommit The raw commit data from Bitbucket.
     * @returns A Commit object.
     */
    private transformCommit(rawCommit: Schema.Commit): Commit {
        const [name, email] = this.extractUsernameEmail(rawCommit?.author);

        return {
            sha: rawCommit.hash ?? '',
            commit: {
                author: {
                    id: this.sanitizeUUID(rawCommit.author?.user?.uuid) ?? '',
                    name: name ?? '',
                    email: email ?? '',
                    date: rawCommit.date ?? '',
                },
                message: rawCommit.message ?? '',
            },
            parents:
                rawCommit.parents
                    ?.map((parent) => ({
                        sha: parent.hash ?? '',
                    }))
                    .filter((parent) => parent.sha) ?? [],
        };
    }

    private readonly _prStateMap = new Map<
        Schema.Pullrequest['state'],
        PullRequestState
    >([
        ['OPEN', PullRequestState.OPENED],
        ['MERGED', PullRequestState.MERGED],
        ['DECLINED', PullRequestState.CLOSED],
        ['SUPERSEDED', PullRequestState.CLOSED],
    ]);

    private readonly _prStateMapReversed = new Map<
        PullRequestState,
        Schema.Pullrequest['state'][]
    >([
        [PullRequestState.OPENED, ['OPEN']],
        [PullRequestState.MERGED, ['MERGED']],
        [PullRequestState.CLOSED, ['DECLINED']],
        [PullRequestState.ALL, ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']],
    ]);

    private readonly _prClosedStates: Array<Schema.Pullrequest['state']> = [
        'DECLINED',
        'SUPERSEDED',
        'MERGED',
    ];

    /**
     * Transforms a raw pull request object from the Bitbucket API into the standard PullRequest interface.
     * @param pullRequest - The raw pull request data from the Bitbucket API.
     * @param organizationAndTeamData - The organization and team context.
     * @returns A PullRequest object.
     */
    private transformPullRequest(
        pullRequest: Schema.Pullrequest,
        organizationAndTeamData: OrganizationAndTeamData,
    ): PullRequest {
        return {
            id: pullRequest?.id?.toString() ?? '',
            number: pullRequest?.id ?? -1,
            pull_number: pullRequest?.id ?? -1, // TODO: remove, legacy, use number
            organizationId: organizationAndTeamData?.organizationId ?? '',
            title: pullRequest?.title ?? '',
            body: pullRequest?.summary?.raw ?? '',
            state:
                this._prStateMap.get(pullRequest?.state) ??
                PullRequestState.ALL,
            prURL: pullRequest?.links?.html?.href ?? '',
            repository:
                pullRequest?.source?.repository?.full_name ??
                pullRequest?.source?.repository?.name ??
                '', // TODO: remove, legacy, use repositoryData
            repositoryId:
                this.sanitizeUUID(
                    pullRequest?.source?.repository?.uuid ?? '',
                ) ?? '', // TODO: remove, legacy, use repositoryData
            repositoryData: {
                id:
                    this.sanitizeUUID(
                        pullRequest?.source?.repository?.uuid ?? '',
                    ) ?? '',
                name:
                    pullRequest?.source?.repository?.full_name ??
                    pullRequest?.source?.repository?.name ??
                    '',
            },
            message: pullRequest?.title ?? '',
            created_at: pullRequest?.created_on ?? '',
            closed_at: this._prClosedStates?.includes(pullRequest?.state)
                ? (pullRequest?.updated_on ?? '')
                : '',
            updated_at: pullRequest?.updated_on ?? '',
            merged_at:
                pullRequest?.state === 'MERGED'
                    ? (pullRequest?.updated_on ?? '')
                    : '',
            participants:
                pullRequest?.participants?.map((p) => ({
                    id: this.sanitizeUUID(p?.user?.uuid ?? '') ?? '',
                })) ?? [],
            reviewers:
                pullRequest?.reviewers?.map((r) => ({
                    id: this.sanitizeUUID(r?.uuid ?? '') ?? '',
                })) ?? [],
            sourceRefName: pullRequest?.source?.branch?.name ?? '', // TODO: remove, legacy, use head.ref
            head: {
                ref: pullRequest?.source?.branch?.name ?? '',
                repo: {
                    id:
                        this.sanitizeUUID(
                            pullRequest?.source?.repository?.uuid ?? '',
                        ) ?? '',
                    name: pullRequest?.source?.repository?.name ?? '',
                    defaultBranch:
                        pullRequest?.source?.repository?.mainbranch?.name ?? '',
                    fullName: pullRequest?.source?.repository?.full_name ?? '',
                },
            },
            targetRefName: pullRequest?.destination?.branch?.name ?? '', // TODO: remove, legacy, use base.ref
            base: {
                ref: pullRequest?.destination?.branch?.name ?? '',
                repo: {
                    id:
                        this.sanitizeUUID(
                            pullRequest?.destination?.repository?.uuid ?? '',
                        ) ?? '',
                    name: pullRequest?.destination?.repository?.name ?? '',
                    defaultBranch:
                        pullRequest?.destination?.repository?.mainbranch
                            ?.name ?? '',
                    fullName:
                        pullRequest?.destination?.repository?.full_name ?? '',
                },
            },
            user: {
                login: pullRequest?.author?.display_name ?? '',
                name: pullRequest?.author?.display_name ?? '',
                id: this.sanitizeUUID(pullRequest?.author?.uuid ?? '') ?? '',
            },
            isDraft: (pullRequest?.draft as boolean | undefined) ?? false,
        };
    }

    private transformRepositoryFile(file: Schema.Treeentry): RepositoryFile {
        return {
            filename: file?.path?.split('/').pop() ?? '',
            sha: '', // Bitbucket does not provide file SHA in the tree entry
            size: -1, // Bitbucket does not provide file size in the tree entry
            path: file?.path ?? '',
            type: file?.type ?? 'blob',
        };
    }
}
