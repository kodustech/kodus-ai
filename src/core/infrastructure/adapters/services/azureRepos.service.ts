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
import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
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
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { v4 as uuidv4 } from 'uuid';
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

@Injectable()
@IntegrationServiceDecorator(PlatformType.AZURE_REPOS, 'codeManagement')
export class AzureReposService {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parameterService: IParametersService,
        private readonly promptService: PromptService,
        private readonly logger: PinoLoggerService,
    ) {}
    getLanguageRepository(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    createSingleIssueComment(params: any): Promise<any | null> {
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

    async countReactions(params: any): Promise<any[]> {
        throw new Error('Method not implemented.');
    }
    getAuthenticationOAuthToken(params: any): Promise<string> {
        throw new Error('Method not implemented.');
    }
    updateDescriptionInPullRequest(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    getPullRequestDetails(params: any): Promise<PullRequestDetails | null> {
        throw new Error('Method not implemented.');
    }
    getDefaultBranch(params: any): Promise<string> {
        throw new Error('Method not implemented.');
    }
    getChangedFilesSinceLastCommit(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    findTeamAndOrganizationIdByConfigKey(
        params: any,
    ): Promise<IntegrationConfigEntity | null> {
        throw new Error('Method not implemented.');
    }
    updateIssueComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    createIssueComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    getCommitsForPullRequestForCodeReview(params: any): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }
    createReviewComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }
    indexRepositoriesForCodeReview(params: any): Promise<void> {
        throw new Error('Method not implemented.');
    }

    getPullRequestByNumber(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }

    getRepositoryContentFile(params: any): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }

    createCommentInPullRequest(params: any): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }

    getFilesByPullRequestId(params: any): Promise<any[] | null> {
        throw new Error('Method not implemented.');
    }

    async createAuthIntegration(params: any): Promise<any> {
        try {
            const authUuid = uuidv4();

            const authIntegration = await this.authIntegrationService.create({
                uuid: authUuid,
                status: true,
                authDetails: {
                    tenantId: params.tenantId,
                },
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            });

            const integrationUuid = uuidv4();

            await this.integrationService.create({
                uuid: integrationUuid,
                platform: PlatformType.AZURE_REPOS,
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                status: true,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                authIntegration: { uuid: authIntegration.uuid },
            });

            return {
                success: true,
            };
        } catch (error) {
            console.log(error);
            throw error;
        }
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

            return await this.integrationConfigService.createOrUpdateConfig(
                params.configKey,
                params.configValue,
                integration?.uuid,
                params.organizationAndTeamData,
            );
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async getOrganizations(params: any): Promise<Organization[]> {
        try {
            const { client, integration } =
                await this.getAzureReposParams(params);

            const data = await client.get('/api/organizations');

            // Maps the response to the structure of the Domain type
            const organizations = data.map(
                (item: Organization): Organization => ({
                    name: item.name,
                    id: item.id,
                    url: item.url,
                    selected: item.id.includes(
                        integration?.authIntegration?.authDetails?.organization
                            ?.id,
                    ),
                }),
            );

            return organizations;
        } catch (error) {
            console.log(error);
        }
    }

    async getPullRequests(params: any): Promise<PullRequests[]> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return null;
            }

            const { client } = await this.getAzureReposParams(params);

            const filters = params?.filters ?? {};
            const repoFilter = params?.repo ?? null;

            let repositories = await this.findOneByOrganizationIdAndConfigKey(
                params?.organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

            if (!repositories) {
                return null;
            }

            if (repoFilter) {
                repositories = repositories.filter(
                    (repo) => repo.name === repoFilter,
                );
            }

            const { startDate, endDate } = filters || {};
            const startDateOnly = startDate
                ? moment(startDate, 'YYYY-MM-DD HH:mm')
                      .startOf('day')
                      .add(1, 'minute')
                      .format('YYYY-MM-DD HH:mm')
                : null;

            const endDateOnly = endDate
                ? moment(endDate, 'YYYY-MM-DD HH:mm')
                      .endOf('day')
                      .subtract(1, 'minute')
                      .format('YYYY-MM-DD HH:mm')
                : null;

            let criteria = `?$orderby=${encodeURIComponent('creationDate desc')}&searchCriteria.status=completed`;

            // Adicionar os filtros de data à URL
            if (startDateOnly && endDateOnly) {
                criteria += `&searchCriteria.minTime=${encodeURIComponent(startDateOnly)}&searchCriteria.maxTime=${encodeURIComponent(endDateOnly)}&searchCriteria.queryTimeRangeType=Created`;
            } else if (startDateOnly) {
                criteria += `&searchCriteria.minTime=${encodeURIComponent(startDateOnly)}&searchCriteria.queryTimeRangeType=Created`;
            } else if (endDateOnly) {
                criteria += `&searchCriteria.maxTime=${encodeURIComponent(endDateOnly)}&searchCriteria.queryTimeRangeType=Created`;
            }

            const promises = repositories.map(async (repo) => {
                return client.get('/api/pull-request-by-repo', {
                    params: {
                        repositoryId: repo?.id,
                        criteria,
                    },
                });
            });

            const results = await Promise.all(promises);

            const pullRequests =
                results
                    .flat(Infinity)
                    .sort((a, b) => {
                        return (
                            new Date(b.closedDate).getTime() -
                            new Date(a.closedDate).getTime()
                        );
                    })
                    .map((pr) => ({
                        id: pr.pullRequestId,
                        author_id: pr.createdBy.id,
                        author_name: pr.createdBy.displayName,
                        message: pr.description,
                        created_at: pr.creationDate,
                        closed_at: pr.closedDate,
                        targetRefName: pr.targetRefName,
                        sourceRefName: pr.sourceRefName,
                        state: pr.state,
                        organizationId:
                            params?.organizationAndTeamData?.organizationId,
                    })) || null;

            return pullRequests;
        } catch (err) {
            console.log(err);
            return [];
        }
    }

    async getRepositories(params: any): Promise<Repositories[]> {
        try {
            const { client, integration } =
                await this.getAzureReposParams(params);

            const repos = await client.get('/api/repositories');

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: params.organizationAndTeamData.teamId },
                });

            return repos?.map((repo) => ({
                id: repo.id,
                name: repo.name,
                project: {
                    id: repo?.project?.id,
                    name: repo?.project?.name,
                },
                selected: integrationConfig?.configValue?.some(
                    (repository: { name: string }) =>
                        repository?.name === repo?.name,
                ),
            }));
        } catch (error) {
            console.log(error);
        }
    }

    async getListMembers(params: any): Promise<User[]> {
        const { client } = await this.getAzureReposParams(params);

        const data = await client.get(`/api/members`);

        return data
            ?.filter((member) => member?.metaType === 'member')
            ?.map((member: any) => ({
                id: member.originId,
                name: member.displayName,
                email: member.mailAddress,
            }));
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
                platformName: 'azure-repos',
                isSetupComplete:
                    azureReposOrg?.authIntegration?.authDetails?.organization &&
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

    async predictDeploymentType(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }) {
        try {
            const repositories = await this.findOneByOrganizationIdAndConfigKey(
                params.organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

            if (!repositories) {
                return null;
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
                context: AzureReposService.name,
                serviceName: 'PredictDeploymentType',
                error: error,
                metadata: {
                    teamId: params.organizationAndTeamData.teamId,
                },
            });
        }
    }

    async savePredictedDeploymentType(params: any) {
        const integration = await this.integrationService.findOne({
            organization: {
                uuid: params.organizationAndTeamData.organizationId,
            },
            team: {
                uuid: params.organizationAndTeamData.teamId,
            },
            platform: PlatformType.AZURE_REPOS,
            status: true,
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

    async getDataForCalculateDeployFrequency(
        params: any,
    ): Promise<DeployFrequency[]> {
        try {
            let deployFrequency: DeployFrequency[] = [];

            const { organizationAndTeamData, doraMetricsConfig } = params;

            const repositories = await this.findOneByOrganizationIdAndConfigKey(
                organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

            if (!repositories) {
                return;
            }

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

            const deployFrequencyPromises = repositories
                ?.map((repo) => {
                    const workflow =
                        teamConfig?.configValue?.value?.workflows.find(
                            (config: any) => config.repo === repo.name,
                        );

                    if (
                        teamConfig?.configValue?.type === 'deployment' &&
                        !workflow &&
                        !workflow?.id
                    ) {
                        return;
                    }

                    return this.getRepoData(
                        organizationAndTeamData,
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
            console.log(error);
        }
    }

    async getCommitsByReleaseMode(
        params: any,
    ): Promise<CommitLeadTimeForChange[]> {
        try {
            const { organizationAndTeamData, deployFrequencyData } = params;

            const { client } = await this.getAzureReposParams(params);

            const repositories = await this.findOneByOrganizationIdAndConfigKey(
                organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

            if (!repositories) {
                return;
            }

            let commitsLeadTimeForChange: CommitLeadTimeForChange[] = [];

            for (let index = 0; index < repositories.length; index++) {
                const repo = repositories[index];

                const deployFrequencyFiltered = deployFrequencyData.filter(
                    (deployFrequency) =>
                        deployFrequency?.repository?.name === repo?.name,
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
                            lastDeploy.teamConfig?.configValue?.type === 'PRs'
                        ) {
                            commits = await this.getCommitsFromPullRequest(
                                client,
                                repo.id,
                                lastDeploy?.id,
                            );
                        }

                        if (commits?.length > 0) {
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
            console.log(error);
        }
    }

    // NOT IMPLEMENTED,
    // BECAUSE AZURE REPOS DON'T HAVE SPECIFIC API FOR GET THE CHANGES LINES OF CODE.
    async getPullRequestsWithFiles(
        params,
    ): Promise<PullRequestWithFiles[] | null> {
        return null;
        // if (!params?.organizationAndTeamData.organizationId) {
        //     return null;
        // }

        // const { client } = await this.getAzureReposParams(params);

        // const filters = params?.filters ?? {};
        // const { startDate, endDate } = filters?.period || {};

        // const repositories = await this.findOneByOrganizationIdAndConfigKey(
        //     params?.organizationAndTeamData,
        //     IntegrationConfigKey.REPOSITORIES,
        // );

        // if (!repositories) {
        //     return null;
        // }

        // const pullRequestsWithFiles: PullRequestWithFiles[] = [];

        // for (const repo of repositories) {
        //     const pullRequests = await this.getPullRequests({
        //         repo: repo.name,
        //         organizationAndTeamData: params?.organizationAndTeamData,
        //         filters: {
        //             startDate,
        //             endDate,
        //         },
        //     });

        //     const pullRequestDetails = await Promise.all(
        //         pullRequests.map(async (pullRequest) => {
        //             const files = await this.getPullRequestFiles(
        //                 client,
        //                 repo.id,
        //                 pullRequest,
        //             );

        //             return {
        //                 id: parseInt(pullRequest.id),
        //                 pull_number: parseInt(pullRequest.id),
        //                 state: 'pullRequest.state',
        //                 title: 'pullRequest.title',
        //                 repository: repo,
        //                 pullRequestFiles: files,
        //             };
        //         }),
        //     );

        //     pullRequestsWithFiles.push(...pullRequestDetails);
        // }

        // return pullRequestsWithFiles;
    }

    async getPullRequestsForRTTM(
        params,
    ): Promise<PullRequestCodeReviewTime[] | null> {
        if (!params?.organizationAndTeamData.organizationId) {
            return null;
        }

        const { client } = await this.getAzureReposParams(params);

        const filters = params?.filters ?? {};
        const { startDate, endDate } = filters?.period || {};

        const repositories = await this.findOneByOrganizationIdAndConfigKey(
            params?.organizationAndTeamData,
            IntegrationConfigKey.REPOSITORIES,
        );

        if (!repositories) {
            return null;
        }

        const pullRequestCodeReviewTime: PullRequestCodeReviewTime[] = [];

        for (const repo of repositories) {
            const pullRequests = await this.getPullRequests({
                repo: repo.name,
                organizationAndTeamData: params?.organizationAndTeamData,
                filters: {
                    startDate,
                    endDate,
                },
            });

            const pullRequestsFormatted = pullRequests?.map((pullRequest) => ({
                id: parseInt(pullRequest.id),
                created_at: pullRequest.created_at,
                closed_at: pullRequest.closed_at,
            }));

            pullRequestCodeReviewTime.push(...pullRequestsFormatted);
        }

        return pullRequestCodeReviewTime;
    }

    async getCommits(params: any): Promise<Commit[]> {
        try {
            const repositories = await this.findOneByOrganizationIdAndConfigKey(
                params.organizationAndTeamData,
                IntegrationConfigKey.REPOSITORIES,
            );

            if (!repositories) {
                return null;
            }

            const { client } = await this.getAzureReposParams(params);

            const { startDate, endDate } = params.filters || {};

            const promises = repositories?.map(async (repo) => {
                return await this.getAllCommits(
                    client,
                    repo.id,
                    startDate,
                    endDate,
                );
            });

            const results = await Promise.all(promises);

            const commits =
                results.flat().map((item) => ({
                    sha: item.sha,
                    commit: {
                        author: {
                            id: item?.commit?.author?.id,
                            name: item?.commit?.author?.name,
                            email: item?.commit?.author?.email,
                            date: item?.commit?.author?.date,
                        },
                        message: item.commit.message,
                    },
                })) || null;

            return commits;
        } catch (err) {
            console.log(err);
            return [];
        }
    }

    async getAllCommits(
        client,
        repoId: string,
        startDate?: string,
        endDate?: string,
    ): Promise<Commit[]> {
        try {
            const startDateOnly = startDate
                ? moment(startDate, 'YYYY-MM-DD HH:mm')
                      .startOf('day')
                      .add(1, 'minute')
                      .format('YYYY-MM-DD HH:mm')
                : null;

            const endDateOnly = endDate
                ? moment(endDate, 'YYYY-MM-DD HH:mm')
                      .endOf('day')
                      .subtract(1, 'minute')
                      .format('YYYY-MM-DD HH:mm')
                : null;

            let criteria = ``;

            if (startDateOnly && endDateOnly) {
                criteria += `&$searchCriteria.fromDate=${encodeURIComponent(startDateOnly)}&$searchCriteria.toDate=${encodeURIComponent(endDateOnly)}`;
            } else if (startDateOnly) {
                criteria += `&$searchCriteria.fromDate=${encodeURIComponent(startDateOnly)}`;
            } else if (endDateOnly) {
                criteria += `&$searchCriteria.toDate=${encodeURIComponent(endDateOnly)}`;
            }

            const commits = await client.get('/api/repository-commits', {
                params: {
                    repositoryId: repoId,
                    criteria,
                },
            });

            return commits
                ?.map((commit) => ({
                    sha: commit.commitId,
                    commit: {
                        author: commit.author,
                        message: commit.comment,
                    },
                }))
                .sort((a, b) => {
                    return (
                        new Date(a.commit.author.date).getTime() -
                        new Date(b.commit.author.date).getTime()
                    );
                });
        } catch (error) {
            console.error('Error fetching commits: ', error);
            return [];
        }
    }

    async getCommitsForTagName(
        lastDeploy,
        secondLastDeploy,
    ): Promise<Commit[]> {
        return await this.getCommitsBetweenTags(
            lastDeploy.repository,
            secondLastDeploy.tag_name,
            lastDeploy.tag_name,
        );
    }

    async getCommitsBetweenTags(repo, baseTag, headTag): Promise<Commit[]> {
        return null;
    }

    async getCommitsFromPullRequest(
        client: any,
        repositoryId: string,
        pullRequestId: number,
        criteria = '',
    ) {
        const commits = await client.get('/api/pull-request-commits', {
            params: {
                repositoryId,
                criteria,
                pullRequestId,
            },
        });

        return commits
            ?.map((commit) => ({
                sha: commit.commitId,
                commit: {
                    author: commit.author,
                    message: commit.comment,
                },
            }))
            .sort((a, b) => {
                return (
                    new Date(a.commit.author.date).getTime() -
                    new Date(b.commit.author.date).getTime()
                );
            });
    }

    async getWorkflows(params: any) {
        const { client, organizationAndTeamData, repositories } = params;

        const workflows = [];

        for (const repo of repositories) {
            const workflowsFromRepo = await client.get('/api/list-all-builds', {
                params: {
                    repository: repo,
                },
            });

            if (!workflowsFromRepo || workflowsFromRepo?.length <= 0) {
                continue;
            }

            workflows.push({
                repo: repo,
                workflows: workflowsFromRepo,
            });
        }

        if (!workflows || workflows?.length <= 0) {
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

    private async getPullRequestFiles(
        client: any,
        repositoryId: string,
        pullRequest: any,
    ): Promise<PullRequestFile[]> {
        const files = await client.get('/api/pull-request-files', {
            params: {
                repositoryId,
                pullRequest,
            },
        });

        return files?.map((file) => ({
            additions: file.additions,
            changes: file.changes,
            deletions: file.deletions,
            status: file.status,
        }));
    }

    private async getRepoData(
        organizationAndTeamData: OrganizationAndTeamData,
        repo: any,
        teamConfig: any,
        startDate: string,
        endDate: string,
    ): Promise<DeployFrequency[]> {
        try {
            const workflow = teamConfig?.configValue?.value?.workflows.find(
                (config: any) => config.repo === repo,
            );
            let releasesFromRepo: any[] = [];

            if (teamConfig?.configValue?.type === 'PRs') {
                releasesFromRepo = await this.getPullRequests({
                    repo: repo.name,
                    organizationAndTeamData,
                    filters: {
                        startDate,
                        endDate,
                    },
                });
            }

            return releasesFromRepo?.map((release) => ({
                id: release.number ?? release?.id,
                created_at: release?.created_at,
                closed_at: release?.closed_at,
                repository: repo,
                teamConfig,
                tag_name: release?.tag_name || release?.head_branch,
                published_at: release?.published_at,
            }));
        } catch (error) {
            console.log(error);
        }
    }

    private async getDeployRuns(
        repo: string,
        workflowId: number,
        startDate: string,
        endDate: string,
    ): Promise<any[]> {
        // return await octokit.paginate(octokit.actions.listWorkflowRuns, {
        //     owner: githubAuthDetail?.org,
        //     repo: repo,
        //     workflow_id: workflowId,
        //     status: 'completed',
        //     created: `${startDate}..${endDate}`,
        //     per_page: 100,
        // });
        return null;
    }

    private async getAzureReposParams(params: any) {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            const { tenantId, organization } =
                integration.authIntegration.authDetails;

            return {
                client: new AxiosAzureReposService({
                    tenantId,
                    organization:
                        params?.organizationSelected?.name ||
                        organization?.name,
                }),
                integration,
            };
        } catch (error) {
            console.log(error);
        }
    }

    private async ensureAuthenticatedIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            return await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: {
                    uuid: organizationAndTeamData.teamId,
                },
                platform: PlatformType.AZURE_REPOS,
                status: true,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error executing ensureAuthenticatedIntegration',
                context: AzureReposService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });

            throw error;
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

    async getPullRequestReviewComment(params: any): Promise<any | null> {
        return null;
    }

    async createResponseToComment(params: any): Promise<any | null> {
        throw new Error(
            'Method createResponseToComment not implemented for AzureReposService',
        );
    }
}
