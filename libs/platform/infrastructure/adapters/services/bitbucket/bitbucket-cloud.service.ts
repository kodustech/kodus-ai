import { createLogger } from '@kodus/flow';

import { fitPRDescription } from '@libs/code-review/utils/fit-pr-description';
import { INTEGRATION_REQUEST_TIMEOUT_MS } from '@libs/core/infrastructure/http/integration-timeouts';
import {
    parkRateGate,
    rateGateKey,
    runWithRateGate,
} from '@libs/core/infrastructure/http/per-key-rate-gate';
import { hasKodyMarker } from '@libs/common/utils/codeManagement/codeCommentMarkers';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@libs/common/utils/glob-utils';
import {
    CreateAuthIntegrationStatus,
    IntegrationCategory,
    IntegrationConfigKey,
    PlatformType,
    PullRequestState,
} from '@libs/core/domain/enums';
import {
    CommentResult,
    FileChange,
    Repository,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { TreeItem } from '@libs/core/infrastructure/config/types/general/tree.type';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { BitbucketAuthDetail } from '@libs/integrations/domain/authIntegrations/types/bitbucket-auth-detail.type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@libs/integrations/domain/integrations/entities/integration.entity';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import {
    CodeManagementConnectionStatus,
    PullRequestFileChange,
} from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { ICodeManagementService } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import { GitCloneParams } from '@libs/platform/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
import {
    CodeManagementIssue,
    GetIssueParams,
    ListIssuesParams,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/issues.type';
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
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { RepositoryFile } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import { AuthorContribution } from '@libs/platformData/domain/pullRequests/interfaces/authorContributor.interface';
import { IRepository } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APIClient, Bitbucket, Schema } from 'bitbucket';
import { Response as BitbucketResponse } from 'bitbucket/src/request/types';
import { v4 } from 'uuid';
import {
    buildDefaultSourceBranchName,
    DEFAULT_COMMIT_MESSAGE,
    DEFAULT_PR_TITLE,
    EMPTY_REPO_DEFAULT_BRANCH,
    EMPTY_REPO_SEED_COMMIT_MESSAGE,
    EMPTY_REPO_SEED_CONTENT,
    EMPTY_REPO_SEED_PATH,
} from '../code-management-defaults.constants';

@Injectable()
export class BitbucketCloudService implements Omit<
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
    private readonly logger = createLogger(BitbucketCloudService.name);

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

    async findRepositoryByName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        name: string;
    }) {
        const { organizationAndTeamData, name } = params;

        try {
            const repositories = await this.getRepositories({
                organizationAndTeamData: organizationAndTeamData,
            });

            const wanted = name.trim().toLowerCase();
            const repository = repositories.find(
                (repo) =>
                    repo.name.toLowerCase() === wanted ||
                    repo.full_name?.toLowerCase() === wanted ||
                    `${repo.organizationName}/${repo.name}`.toLowerCase() ===
                        wanted,
            );

            if (!repository) {
                return null;
            }

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
                message: 'Error finding repository by name in Bitbucket',
                context: BitbucketCloudService.name,
                error,
                metadata: { params },
            });
            throw new BadRequestException(error);
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
        files: PullRequestFileChange[];
    }): Promise<Partial<PullRequest> | null> {
        const {
            organizationAndTeamData,
            repository,
            sourceBranch,
            targetBranch,
            baseBranch,
            title,
            description = '',
            commitMessage,
            author,
            files,
        } = params;

        const resolvedSourceBranch =
            sourceBranch || buildDefaultSourceBranchName();
        const resolvedTitle = title?.trim() || DEFAULT_PR_TITLE;
        const resolvedCommitMessage =
            commitMessage?.trim() || DEFAULT_COMMIT_MESSAGE;

        try {
            const resolvedTargetBranch =
                targetBranch ||
                (await this.getDefaultBranch({
                    organizationAndTeamData,
                    repository,
                })) ||
                EMPTY_REPO_DEFAULT_BRANCH;
            const resolvedBaseBranch = baseBranch || resolvedTargetBranch;

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                throw new BadRequestException(
                    'Failed to get Bitbucket authentication details',
                );
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                throw new BadRequestException(
                    'Failed to get workspace from repository',
                );
            }

            // An empty repository has no default-branch ref yet, so branch
            // creation and the PR below fail. Seed an initial commit so the
            // base branch exists. No-op when the branch is already there.
            await this.ensureBaseBranchExists({
                bitbucketAPI,
                workspace,
                repositoryId: repository.id,
                baseBranch: resolvedBaseBranch,
                author,
            });

            const uploadResult = await this.uploadFiles({
                organizationAndTeamData,
                branchName: resolvedSourceBranch,
                baseBranch: resolvedBaseBranch,
                repository,
                files,
                message: resolvedCommitMessage,
                author,
            });

            if (!uploadResult) {
                throw new BadRequestException(
                    'Failed to upload files to Bitbucket',
                );
            }

            const pr = await bitbucketAPI.pullrequests.create({
                workspace: `{${workspace}}`,
                repo_slug: `{${repository.id}}`,
                // @ts-expect-error: library type definition is incorrect for the body of this endpoint
                _body: {
                    title: resolvedTitle,
                    summary: {
                        raw: description,
                    },
                    source: {
                        branch: {
                            name: resolvedSourceBranch,
                        },
                    },
                    destination: {
                        branch: {
                            name: resolvedTargetBranch,
                        },
                    },
                },
            });

            return {
                id: pr.data.id.toString(),
                number: pr.data.id,
                title: pr.data.title,
                prURL: pr.data.links.html.href,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error creating pull request with files in Bitbucket',
                context: BitbucketCloudService.name,
                error,
                metadata: { params },
            });
            throw new BadRequestException(error);
        }
    }

    async uploadFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        branchName?: string;
        baseBranch?: string;
        files: PullRequestFileChange[];
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
            author,
        } = params;

        try {
            const defaultBranch = await this.getDefaultBranch({
                organizationAndTeamData,
                repository,
            });
            const resolvedBaseBranch = baseBranch || defaultBranch;
            const resolvedBranchName = branchName || resolvedBaseBranch;
            const resolvedMessage = message?.trim() || DEFAULT_COMMIT_MESSAGE;

            const bitbucketAuthDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!bitbucketAuthDetail) {
                throw new BadRequestException(
                    'Failed to get Bitbucket authentication details',
                );
            }

            const bitbucketAPI = this.instanceBitbucketApi(bitbucketAuthDetail);

            const workspace = await this.getWorkspaceFromRepository(
                organizationAndTeamData,
                repository.id,
            );

            if (!workspace) {
                throw new BadRequestException(
                    'Failed to get workspace from repository',
                );
            }

            const branchAlreadyExists =
                resolvedBranchName === resolvedBaseBranch
                    ? true
                    : await this.checkBitbucketBranchExists({
                          bitbucketAPI,
                          workspace,
                          repositoryId: repository.id,
                          branchName: resolvedBranchName,
                      });

            const baseBranchHead =
                !branchAlreadyExists &&
                resolvedBranchName !== resolvedBaseBranch
                    ? await this.getBitbucketBranchHeadHash({
                          bitbucketAPI,
                          workspace,
                          repositoryId: repository.id,
                          branchName: resolvedBaseBranch,
                      })
                    : null;

            if (
                !branchAlreadyExists &&
                resolvedBranchName !== resolvedBaseBranch &&
                !baseBranchHead
            ) {
                throw new BadRequestException(
                    `Base branch "${resolvedBaseBranch}" not found.`,
                );
            }

            const form = new FormData();

            form.append('branch', resolvedBranchName);
            form.append('message', resolvedMessage);

            if (!branchAlreadyExists && baseBranchHead) {
                form.append('parents', baseBranchHead);
            }

            if (
                bitbucketAuthDetail.authMode === AuthMode.TOKEN &&
                author?.name
            ) {
                form.append(
                    'author',
                    `${author.name} <${author.email || 'kody@kodus.io'}>`,
                );
            }

            files.forEach((file) => {
                const operation = file.operation || 'upsert';
                const repoPath = file.path.startsWith('/')
                    ? file.path
                    : `/${file.path}`;

                if (operation === 'delete') {
                    form.append('files', repoPath);
                    return;
                }

                if (typeof file.content !== 'string') {
                    throw new Error(
                        `File content is required for upsert operation: ${file.path}`,
                    );
                }

                form.append(repoPath, file.content);
            });

            await bitbucketAPI.source.createFileCommit({
                workspace: `{${workspace}}`,
                repo_slug: `{${repository.id}}`,
                _body: form,
            });

            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error uploading files to Bitbucket',
                context: BitbucketCloudService.name,
                error,
                metadata: { params },
            });

            return false;
        }
    }

    private async checkBitbucketBranchExists(params: {
        bitbucketAPI: any;
        workspace: string;
        repositoryId: string;
        branchName: string;
    }): Promise<boolean> {
        const head = await this.getBitbucketBranchHeadHash(params);
        return Boolean(head);
    }

    // Seeds an empty repository with an initial commit so the base branch
    // exists for the branch + PR flow. A no-op when the branch already exists.
    private async ensureBaseBranchExists(params: {
        bitbucketAPI: any;
        workspace: string;
        repositoryId: string;
        baseBranch: string;
        author?: { name: string; email?: string };
    }): Promise<void> {
        const { bitbucketAPI, workspace, repositoryId, baseBranch, author } =
            params;

        const exists = await this.checkBitbucketBranchExists({
            bitbucketAPI,
            workspace,
            repositoryId,
            branchName: baseBranch,
        });
        if (exists) {
            return;
        }

        // Committing to /src with a `branch` and no `parents` creates the
        // first commit on an empty repository.
        const form = new FormData();
        form.append('branch', baseBranch);
        form.append('message', EMPTY_REPO_SEED_COMMIT_MESSAGE);
        if (author?.name) {
            form.append(
                'author',
                `${author.name} <${author.email || 'kody@kodus.io'}>`,
            );
        }
        form.append(`/${EMPTY_REPO_SEED_PATH}`, EMPTY_REPO_SEED_CONTENT);

        await bitbucketAPI.source.createFileCommit({
            workspace: `{${workspace}}`,
            repo_slug: `{${repositoryId}}`,
            _body: form,
        });

        this.logger.log({
            message:
                'Seeded empty Bitbucket repository with an initial commit for centralized config',
            context: BitbucketCloudService.name,
            metadata: { repositoryId, baseBranch },
        });
    }

    private async getBitbucketBranchHeadHash(params: {
        bitbucketAPI: any;
        workspace: string;
        repositoryId: string;
        branchName: string;
    }): Promise<string | null> {
        try {
            const commitsResponse = await params.bitbucketAPI.commits.list({
                repo_slug: `{${params.repositoryId}}`,
                workspace: `{${params.workspace}}`,
                include: params.branchName,
                pagelen: 1,
            });

            const commit = commitsResponse?.data?.values?.[0];
            return typeof commit?.hash === 'string' ? commit.hash : null;
        } catch (error) {
            if (this.isBitbucketBranchNotFoundError(error)) {
                return null;
            }

            throw error;
        }
    }

    private isBitbucketBranchNotFoundError(error: unknown): boolean {
        const candidate = error as
            | {
                  status?: number;
                  message?: string;
                  response?: {
                      status?: number;
                      data?: { error?: { message?: string } };
                  };
              }
            | undefined;

        const status = candidate?.status || candidate?.response?.status;
        const message =
            candidate?.response?.data?.error?.message ||
            candidate?.message ||
            '';

        const normalizedMessage = message.toLowerCase();

        return (
            status === 404 ||
            normalizedMessage.includes('not found') ||
            normalizedMessage.includes('unknown revision') ||
            normalizedMessage.includes('invalid branch')
        );
    }

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
                        context: BitbucketCloudService.name,
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
                context: BitbucketCloudService.name,
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService getPullRequestsWithChangesRequested',
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
                context: BitbucketCloudService.name,
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
                    context: BitbucketCloudService.name,
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
                    context: BitbucketCloudService.name,
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
                        context: BitbucketCloudService.name,
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
                context: BitbucketCloudService.name,
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
                    context: BitbucketCloudService.name,
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
                    context: BitbucketCloudService.name,
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
                        context: BitbucketCloudService.name,
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
                context: BitbucketCloudService.name,
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
            // @ts-expect-error: defaults property is missing in the library type definition
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
            // @ts-expect-error: state property type mismatch in library definition
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
            // @ts-expect-error: defaults property is missing in the library type definition
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
            // @ts-expect-error: state property type mismatch in library definition
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getPullRequestDetails',
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

            const workspaces = await this.listAccessibleWorkspaces({
                username:
                    bitbucketAuthDetail.email ?? bitbucketAuthDetail.username,
                token: decrypt(bitbucketAuthDetail.appPassword),
            });

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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getRepositories',
                error: error,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(error);
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getListMembers',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService verifyConnection',
                error: err,
                metadata: {
                    params,
                },
            });
            throw new BadRequestException(err);
        }
    }

    async getPullRequestsWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: any;
    }): Promise<PullRequestWithFiles[] | null> {
        try {
            const { organizationAndTeamData } = params;

            const filters = params?.filters ?? {};
            const { prStatus = 'OPEN' } = filters;
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getPullRequestsWithFiles',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getPullRequestsForRTTM',
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
                    context: BitbucketCloudService.name,
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
                        context: BitbucketCloudService.name,
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
                context: BitbucketCloudService.name,
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getFilesByPullRequestId',
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
                context: BitbucketCloudService.name,
                serviceName: 'getIncrementalChangedFilesSinceLastCommit',
                error,
                metadata: { params },
            });
            return null;
        }
    }

    private dedentCode(code: string): string {
        const lines = code.split('\n');
        const indents = lines
            .filter((line) => line.trim().length > 0)
            .map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
        if (indents.length === 0) return code;
        const minIndent = Math.min(...indents);
        if (minIndent === 0) return code;
        return lines
            .map((line) =>
                line.length >= minIndent ? line.slice(minIndent) : line,
            )
            .join('\n');
    }

    private formatCodeBlock(language: string, code: string) {
        return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    private formatBodyForBitbucket(lineComment: any, repository: any) {
        const codeBlock = lineComment?.body?.improvedCode
            ? this.formatCodeBlock(
                  repository?.language?.toLowerCase(),
                  this.dedentCode(lineComment?.body?.improvedCode),
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
                    // @ts-expect-error: _body is required but not typed in the library
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createReviewComment',
                metadata: {
                    params,
                },
            });

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error to create review comment',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createReviewComment',
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
                    // @ts-expect-error: _body is required but not typed in the library
                    _body: {
                        content: {
                            raw: overallComment,
                        },
                    },
                })
                .then((res) => res.data);

            this.logger.log({
                message: `Created line comment for PR#${prNumber}`,
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createReviewComment',
                metadata: {
                    params,
                },
            });

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error to create review comment',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createReviewComment',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getRepositoryContentFile',
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

            return await this.getPullRequest({
                organizationAndTeamData,
                repository,
                prNumber,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error to get pull request by number',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getPullRequestByNumber',
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
                            id: this.sanitizeUUID(
                                commit?.author?.user?.uuid ?? '',
                            ),
                            username: name ?? '',
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService getCommitsForPullRequestForCodeReview',
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
                    // @ts-expect-error: _body is required but not typed in the library
                    _body: {
                        content: {
                            raw: body,
                        },
                    },
                })
                .then((res) => res.data);

            this.logger.log({
                message: `Created issue comment for PR#${prNumber}`,
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createIssueComment',
                metadata: {
                    params,
                },
            });

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error to create issue comment',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createIssueComment',
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
                // @ts-expect-error: _body is required but not typed in the library
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
                    // @ts-expect-error: _body is required but not typed in the library
                    _body: {
                        content: {
                            raw: body,
                        },
                    },
                })
                .then((res) => res.data);

            this.logger.log({
                message: `Updated issue comment for PR#${prNumber}`,
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService updateIssueComment',
                metadata: {
                    params,
                },
            });

            return comment;
        } catch (error) {
            this.logger.error({
                message: 'Error to update issue comment',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService updateIssueComment',
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService markReviewCommentAsResolved',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getDefaultBranch',
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
                        username: comment?.user?.nickname,
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService getPullRequestReviewComment',
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
                    // @ts-expect-error: parent property type mismatch in library definition
                    parent: {
                        id: inReplyToId,
                    },
                },
            });

            return res.data;
        } catch (error) {
            this.logger.error({
                message: 'Error to create response to comment',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createResponseToComment',
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

            // Truncate at the adapter boundary so the per-platform limit
            // is enforced consistently — see fit-pr-description.ts.
            const fittedSummary = fitPRDescription(
                summary,
                PlatformType.BITBUCKET,
            );

            // added ts-ignore because _body expects a type property but Bitbucket rejects it
            await bitbucketAPI.pullrequests.update({
                pull_request_id: prNumber,
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
                // @ts-expect-error: _body is required but not typed in the library
                _body: {
                    summary: {
                        raw: fittedSummary,
                    },
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error to update description in pull request #${params.prNumber}`,
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService updateDescriptionInPullRequest',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getLanguageRepository',
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
        host?: string;
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
                    host: params.host,
                });
            }

            this.mcpManagerService?.createKodusMCPIntegration(
                params.organizationAndTeamData.organizationId,
            );

            return res;
        } catch (err) {
            this.logger.error({
                message: 'Error to create auth integration',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createAuthIntegration',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService updateAuthIntegration',
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService createOrUpdateIntegrationConfig',
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
                        context: BitbucketCloudService.name,
                        serviceName:
                            'BitbucketCloudService createMergeRequestWebhook',
                        metadata: {
                            organizationAndTeamData,
                        },
                    });
                } else {
                    this.logger.log({
                        message: 'Webhook already exists',
                        context: BitbucketCloudService.name,
                        serviceName:
                            'BitbucketCloudService createMergeRequestWebhook',
                        metadata: {
                            organizationAndTeamData,
                        },
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error to create webhook',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService createMergeRequestWebhook',
                error: error,
                metadata: {
                    organizationAndTeamData,
                },
            });
            throw error;
        }
    }

    async listIssues(
        params: ListIssuesParams,
    ): Promise<CodeManagementIssue[]> {
        const { organizationAndTeamData, repository, filters = {} } = params;

        const authDetail = await this.getAuthDetails(organizationAndTeamData);
        if (!authDetail) {
            return [];
        }

        const bitbucketAPI = this.instanceBitbucketApi(authDetail);

        const { data } = await bitbucketAPI.repositories.listIssues({
            workspace: repository.owner,
            repo_slug: repository.name,
            pagelen: Math.min(Math.max(1, filters.perPage ?? 30), 100),
            ...(filters.page ? { page: String(filters.page) } : {}),
        });

        let issues = (data?.values ?? []).map((issue) =>
            this.mapBitbucketIssue(issue),
        );

        // Bitbucket filters via BBQL; keep state filtering client-side for a
        // simple, robust mapping.
        if (filters.state && filters.state !== 'all') {
            issues = issues.filter((issue) => issue.state === filters.state);
        }

        return issues;
    }

    async getIssue(
        params: GetIssueParams,
    ): Promise<CodeManagementIssue | null> {
        const { organizationAndTeamData, repository, issueNumber } = params;

        const authDetail = await this.getAuthDetails(organizationAndTeamData);
        if (!authDetail) {
            return null;
        }

        const bitbucketAPI = this.instanceBitbucketApi(authDetail);

        try {
            const { data } = await bitbucketAPI.repositories.getIssue({
                workspace: repository.owner,
                repo_slug: repository.name,
                issue_id: String(issueNumber),
            });
            return data ? this.mapBitbucketIssue(data) : null;
        } catch (error) {
            if ((error as { status?: number })?.status === 404) {
                return null;
            }
            throw error;
        }
    }

    private mapBitbucketIssue(issue: any): CodeManagementIssue {
        const closedStates = new Set([
            'resolved',
            'closed',
            'invalid',
            'duplicate',
            'wontfix',
        ]);

        const reporter = issue.reporter;
        const assignee = issue.assignee;

        return {
            id: String(issue.id),
            number: issue.id,
            title: issue.title,
            body: issue.content?.raw ?? null,
            state: closedStates.has(issue.state) ? 'closed' : 'open',
            url: issue.links?.html?.href ?? '',
            labels: [],
            assignees: assignee
                ? [assignee.nickname ?? assignee.display_name].filter(
                      (name): name is string => Boolean(name),
                  )
                : [],
            author: reporter
                ? {
                      username: reporter.nickname ?? reporter.display_name,
                      id: reporter.account_id,
                  }
                : null,
            createdAt: issue.created_on,
            updatedAt: issue.updated_on,
            closedAt: null,
            platform: PlatformType.BITBUCKET,
        };
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getAuthDetails',
                error: err,
                metadata: {
                    organizationAndTeamData,
                },
            });
        }
    }

    /**
     * Wraps the default fetch to ensure every Response has a Content-Type
     * header. The bitbucket npm package (v2.12.0) calls
     * `contentType.includes(...)` without a null-check, which crashes when
     * the Bitbucket edge proxy returns a response with no Content-Type.
     */
    // Spacing between Bitbucket API calls that share one app-password.
    // Bitbucket's per-endpoint burst window is 16-60 req/min; 400ms caps
    // any single token at ~150 req/min spread across endpoints which —
    // combined with the gate's single-slot serialization — keeps the
    // onboarding backfill + live review + dashboard polling clear of the
    // burst ceiling. Tunable via env for operators on tighter plans.
    private static readonly RATE_GATE_MIN_INTERVAL_MS = Number(
        process.env.BITBUCKET_RATE_GATE_MIN_INTERVAL_MS ?? 400,
    );

    // How many Retry-After-honoured waits rawFetch performs on a 429 before
    // giving up and surfacing it. 4 covers transient per-endpoint bursts
    // without hanging a request indefinitely on a genuinely throttled account.
    private static readonly RATE_GATE_429_MAX_RETRIES = Number(
        process.env.BITBUCKET_RATE_GATE_429_MAX_RETRIES ?? 4,
    );

    private safeFetch(url: string, options: any): Promise<any> {
        // Gate every Bitbucket HTTP call through a single-slot, spaced
        // queue keyed by the app-password (carried in the Authorization
        // header). safeFetch is the one chokepoint the SDK routes through
        // (see instanceBitbucketApi), so serializing here throttles
        // backfill, review and polling alike without touching every call
        // site. See per-key-rate-gate.ts for why this is proactive rather
        // than relying on with429Retry alone.
        const authHeader =
            options?.headers?.authorization ??
            options?.headers?.Authorization ??
            '';
        const gateKey = rateGateKey('bitbucket', String(authHeader));

        return runWithRateGate(
            gateKey,
            {
                minIntervalMs: BitbucketCloudService.RATE_GATE_MIN_INTERVAL_MS,
            },
            () => this.rawFetch(url, options, gateKey),
        );
    }

    private async rawFetch(
        url: string,
        options: any,
        gateKey: string,
    ): Promise<any> {
        // Retry 429 in-place. EVERY Bitbucket SDK call funnels through here
        // (instanceBitbucketApi sets request.fetch = safeFetch → rawFetch),
        // and almost none of the ~46 call sites wrap themselves in
        // with429Retry. Bitbucket Cloud rate-limits hard (per-endpoint burst
        // ceilings well below its 1000/hr budget), so on a busy account a
        // single 429 on getDefaultBranch / getLanguageRepository /
        // getRepositoryContentFile used to propagate straight up and break
        // the code review (and onboarding). Retrying here — honouring
        // Retry-After, after the gate park — fixes every call site at once:
        // a transient 429 becomes a short wait instead of a failed review.
        // Only a sustained 429 (still limited after RATE_GATE_429_MAX_RETRIES
        // honoured waits) surfaces the 429 to the caller.
        for (let attempt = 0; ; attempt++) {
            // Per-attempt timeout: the Bitbucket SDK exposes no timeout, so
            // without this one unresponsive call hangs the worker for the
            // whole drain window. 30s covers the 99p of real calls.
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                INTEGRATION_REQUEST_TIMEOUT_MS,
            );

            let response: Response;
            try {
                response = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timer);
            }

            if (response.status === 429) {
                // Park the whole key so sibling calls wait out the cooldown
                // instead of re-colliding, then wait it out ourselves and
                // retry. parseRetryAfterMs falls back to a conservative
                // cooldown when Bitbucket omits the header (it often does on
                // per-endpoint burst 429s).
                const waitMs = this.parseRetryAfterMs(
                    response.headers.get('retry-after'),
                );
                parkRateGate(gateKey, Date.now() + waitMs);
                if (attempt < BitbucketCloudService.RATE_GATE_429_MAX_RETRIES) {
                    this.logger.warn({
                        message: `Bitbucket 429 — waiting ${waitMs}ms then retrying (attempt ${attempt + 1}/${BitbucketCloudService.RATE_GATE_429_MAX_RETRIES})`,
                        context: BitbucketCloudService.name,
                        metadata: { url, gateKey },
                    });
                    await new Promise((r) => setTimeout(r, waitMs));
                    continue;
                }
                // Exhausted: fall through and return the 429 to the caller.
            }

            if (!response.headers.get('content-type')) {
                const patchedHeaders = new Headers(response.headers);
                patchedHeaders.set('content-type', 'text/plain');
                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: patchedHeaders,
                });
            }
            return response;
        }
    }

    // Parses a Retry-After header (delta-seconds or HTTP-date) into a
    // forward-looking delay in ms. Falls back to a conservative cooldown
    // when the header is absent or unparseable — Bitbucket frequently
    // omits it on per-endpoint burst 429s, and guessing too low just
    // re-trips the window.
    private parseRetryAfterMs(raw: string | null): number {
        const fallbackMs = BitbucketCloudService.RATE_GATE_MIN_INTERVAL_MS * 25;
        if (!raw) return fallbackMs;
        const asSeconds = Number(raw);
        if (Number.isFinite(asSeconds) && asSeconds >= 0) {
            return Math.round(asSeconds * 1000);
        }
        const asDate = Date.parse(raw);
        if (Number.isFinite(asDate)) {
            const delta = asDate - Date.now();
            return delta > 0 ? delta : fallbackMs;
        }
        return fallbackMs;
    }

    /**
     * Lists workspaces the authenticated user can access via the new
     * GET /2.0/user/workspaces endpoint. Required because Atlassian sunsetted
     * the cross-workspace GET /2.0/workspaces and GET /2.0/user/permissions/workspaces
     * endpoints on 2026-04-14 (CHANGE-2770 / CHANGE-3022) and the bitbucket
     * npm SDK (v2.12.0) does not expose this new endpoint.
     */
    private async listAccessibleWorkspaces(auth: {
        username: string;
        token: string;
    }): Promise<Schema.Workspace[]> {
        const basic = Buffer.from(`${auth.username}:${auth.token}`).toString(
            'base64',
        );
        const workspaces: Schema.Workspace[] = [];
        let nextUrl: string | undefined =
            'https://api.bitbucket.org/2.0/user/workspaces?pagelen=50';

        while (nextUrl) {
            const response = await this.safeFetch(nextUrl, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    authorization: `Basic ${basic}`,
                },
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(
                    `GET /2.0/user/workspaces failed with ${response.status}: ${body}`,
                );
            }

            const body = (await response.json()) as {
                values?: Array<{ workspace?: Schema.Workspace }>;
                next?: string;
            };

            for (const entry of body.values ?? []) {
                if (entry?.workspace?.uuid) {
                    workspaces.push(entry.workspace);
                }
            }

            nextUrl = body.next;
        }

        return workspaces;
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
                request: {
                    fetch: this.safeFetch.bind(this),
                },
            });

            return bitbucketAPI;
        } catch (err) {
            this.logger.error({
                message: 'Error to instance Bitbucket API',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService instanceBitbucketApi',
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService findOneByOrganizationAndTeamDataAndConfigKey',
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
        host?: string;
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
                auth: {
                    username: email ?? username,
                    token,
                },
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
                host: params.host,
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService authenticateWithToken',
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
        auth: { username: string; token: string };
    }) {
        try {
            const { bitbucketAPI, auth } = params;

            const workspaces = await this.listAccessibleWorkspaces(auth);

            for (const workspace of workspaces) {
                const repositories = await bitbucketAPI.repositories
                    .list({
                        workspace: workspace.uuid,
                    })
                    .then((res) => res.data.values);

                if (repositories.length > 0) {
                    return {
                        success: true,
                        status: CreateAuthIntegrationStatus.SUCCESS,
                    };
                }
            }

            return {
                success: false,
                status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
            };
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to list repositories when creating integration',
                context: BitbucketCloudService.name,
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService mergePullRequest',
                metadata: {
                    params,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error to merge pull request #${params.prNumber}`,
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService mergePullRequest',
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
                    context: BitbucketCloudService.name,
                    serviceName:
                        'BitbucketCloudService getReviewStatusByPullRequest',
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService getReviewStatusByPullRequest',
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService checkIfPullRequestShouldBeApproved',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService approvePullRequest',
                metadata: {
                    params,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error to approve pull request #${params.prNumber}`,
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService approvePullRequest',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    private getCriticalIssuesSummaryArray(
        criticalComments: CommentResult[],
    ): OneSentenceSummaryItem[] {
        return criticalComments.map((comment) => ({
            id: comment.codeReviewFeedbackData.commentId,
            oneSentenceSummary:
                comment.comment.suggestion.oneSentenceSummary ?? '',
        }));
    }

    private getListOfCriticalIssues(criticalComments: CommentResult[]): string {
        const criticalIssuesSummaryArray =
            this.getCriticalIssuesSummaryArray(criticalComments);

        const listOfCriticalIssues = criticalIssuesSummaryArray
            .map((criticalIssue) => {
                const summary = criticalIssue.oneSentenceSummary;
                return `- ${summary}`.trim();
            })
            .join('\n');

        return listOfCriticalIssues;
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService requestChangesPullRequest',
                metadata: {
                    params,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Error to change status to requested changes on pull request #${params.prNumber}`,
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService requestChangesPullRequest',
                error: error,
                metadata: {
                    params,
                },
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
                    username: comment?.user?.nickname,
                    name: comment?.user?.display_name,
                },
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error to get all comments in pull request',
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService getAllCommentsInPullRequest',
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService getPullRequestsByRepository',
                error: error,
                metadata: {
                    params,
                },
            });
            return null;
        }
    }

    /**
     * Bitbucket's /2.0/users/{selected_user} endpoint only accepts
     * account_id or {uuid}, neither of which is reliably available
     * from the PR webhook payload. The endpoint also does not return
     * email due to GDPR restrictions. User email for Bitbucket is
     * already sourced from commit author raw fields instead.
     */
    async getUserByUsername(_params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any | null> {
        return null;
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getCurrentUser',
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
                            username: (comment?.user?.nickname as string) ?? '',
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
                context: BitbucketCloudService.name,
                serviceName:
                    'BitbucketCloudService getPullRequestReviewComments',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService isWebhookActive',
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
        try {
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
                        context: BitbucketCloudService.name,
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
        } catch (error) {
            this.logger.error({
                message: 'Error authenticating for webhook deletion',
                context: BitbucketCloudService.name,
                error: error,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                },
            });
        }
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
    }): Promise<TreeItem[]> {
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
    ): Promise<TreeItem[]> {
        try {
            const bitbucketAPI =
                this.instanceBitbucketApi(bitbucketAuthDetails);
            const allItems: TreeItem[] = [];
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
                                ? ('directory' as const)
                                : ('file' as const),
                        sha: item.commit?.hash || '',
                        size: item.size || undefined,
                        url: item.links?.self?.href || '',
                        commit: item.commit, // Manter dados do commit se necessário
                        hasChildren: item.type === 'commit_directory', // Marcar diretórios para possível navegação futura
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
                    context: BitbucketCloudService.name,
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
                    context: BitbucketCloudService.name,
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
                    context: BitbucketCloudService.name,
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
                        context: BitbucketCloudService.name,
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
                    context: BitbucketCloudService.name,
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

            const files = fileTrees
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getRepositoryAllFiles',
                metadata: {
                    params,
                    totalFilesFound: fileTrees.length,
                },
            });

            return filteredFiles;
        } catch (error) {
            this.logger.error({
                message: 'Error to get repository files',
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService getRepositoryAllFiles',
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
                    context: BitbucketCloudService.name,
                    serviceName:
                        'BitbucketCloudService updateResponseToComment',
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
                    context: BitbucketCloudService.name,
                    serviceName:
                        'BitbucketCloudService updateResponseToComment',
                    metadata: { organizationAndTeamData, repository, prNumber },
                });
                return null;
            }

            const response = await bitbucketAPI.pullrequests.updateComment({
                repo_slug: `{${repository.id}}`,
                workspace: `{${workspace}}`,
                pull_request_id: prNumber,
                comment_id: Number(commentId),
                // @ts-expect-error: _body is required but not typed in the library
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService updateResponseToComment',
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
                context: BitbucketCloudService.name,
                serviceName: 'BitbucketCloudService isDraftPullRequest',
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
                login:
                    (pullRequest?.author as any)?.account_id ??
                    pullRequest?.author?.uuid ??
                    '',
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

    async getRepositoryContentBatch(
        _params: any,
    ): Promise<Map<string, any> | null> {
        // Not implemented for Bitbucket Cloud — callers fall back to
        // per-file `getRepositoryContentFile`.
        return null;
    }

    async getUsersByUsername(
        _params: any,
    ): Promise<Map<string, any> | null> {
        // Not implemented for Bitbucket Cloud — callers fall back to
        // per-user `getUserByUsername`.
        return null;
    }
}
