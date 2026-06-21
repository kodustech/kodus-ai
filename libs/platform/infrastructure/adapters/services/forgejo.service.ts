import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';

import { createLogger } from '@kodus/flow';
import { fitPRDescription } from '@libs/code-review/utils/fit-pr-description';
import { hasKodyMarker } from '@libs/common/utils/codeManagement/codeCommentMarkers';
import { getCodeReviewBadge } from '@libs/common/utils/codeManagement/codeReviewBadge';
import { getLabelShield } from '@libs/common/utils/codeManagement/labels';
import { getSeverityLevelShield } from '@libs/common/utils/codeManagement/severityLevel';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { IntegrationServiceDecorator } from '@libs/common/utils/decorators/integration-service.decorator';
import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@libs/common/utils/glob-utils';
import { extractOwnerAndRepo } from '@libs/common/utils/helpers';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@libs/common/utils/translations/translations';
import {
    CreateAuthIntegrationStatus,
    IntegrationCategory,
    IntegrationConfigKey,
    LanguageValue,
    PlatformType,
    PullRequestState,
} from '@libs/core/domain/enums';
import {
    CommentResult,
    Repository,
    ReviewComment,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { TreeItem } from '@libs/core/infrastructure/config/types/general/tree.type';

import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { ForgejoAuthDetail } from '@libs/integrations/domain/authIntegrations/types/forgejo-auth-detail.type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import {
    CodeManagementConnectionStatus,
    ICodeManagementService,
    PullRequestFileChange,
} from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import { GitCloneParams } from '@libs/platform/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
import { Organization } from '@libs/platform/domain/platformIntegrations/types/codeManagement/organization.type';
import {
    OneSentenceSummaryItem,
    PullRequest,
    PullRequestAuthor,
    PullRequestCodeReviewTime,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequestsWithChangesRequested,
    PullRequestWithFiles,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { RepositoryFile } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import {
    buildDefaultSourceBranchName,
    DEFAULT_COMMIT_MESSAGE,
    DEFAULT_PR_TITLE,
} from './code-management-defaults.constants';

import { Reaction } from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import {
    type ChangedFile as ForgejoChangedFile,
    type Commit as ForgejoCommit,
    type Organization as ForgejoOrganization,
    type PullRequest as ForgejoPullRequest,
    type PullReview as ForgejoPullReview,
    type Repository as ForgejoRepository,
    type User as ForgejoUser,
    getTree,
    issueCreateComment,
    issueDeleteCommentReaction,
    issueDeleteIssueReaction,
    issueEditComment,
    issueGetComments,
    issueGetIssueReactions,
    issuePostCommentReaction,
    issuePostIssueReaction,
    orgListCurrentUserOrgs,
    orgListMembers,
    orgListRepos,
    repoCreateHook,
    repoCreatePullReview,
    repoDeleteHook,
    repoDownloadPullDiffOrPatch,
    repoEditHook,
    repoEditPullRequest,
    repoGet,
    repoGetAllCommits,
    repoGetContents,
    repoGetLanguages,
    repoGetPullRequest,
    repoGetPullRequestCommits,
    repoGetPullRequestFiles,
    repoGetPullReviewComments,
    repoListHooks,
    repoListPullRequests,
    repoListPullReviews,
    repoMergePullRequest,
    userCurrentListRepos,
    userGet,
    userGetCurrent,
    userSearch,
    repoChangeFiles,
    repoCreatePullRequest,
} from '@llamaduck/forgejo-ts';
import { Client, createClient } from '@llamaduck/forgejo-ts/client';

@Injectable()
@IntegrationServiceDecorator(PlatformType.FORGEJO, 'codeManagement')
export class ForgejoService implements Omit<
    ICodeManagementService,
    | 'getAuthenticationOAuthToken'
    | 'getUserById'
    | 'minimizeComment'
    | 'markReviewCommentAsResolved' // Currently forgejo doesn't support marking comments as resolved gitea added this on 01/02/2026 but forgejo hasn't yet'
> {
    private readonly logger = createLogger(ForgejoService.name);

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        private readonly configService: ConfigService,
    ) {}

    public createForgejoClient(authDetail: ForgejoAuthDetail): Client {
        const token = decrypt(authDetail.accessToken);
        return createClient({
            baseURL: `${authDetail.host}/api/v1`,
            headers: {
                Authorization: `token ${token}`,
            },
        });
    }

    /**
     * Helper to paginate through all results of an API endpoint.
     * Forgejo uses page-based pagination with a default limit of 50.
     */
    private async paginate<T>(
        fetchPage: (page: number, limit: number) => Promise<T[]>,
        options: { limit?: number; maxPages?: number } = {},
    ): Promise<T[]> {
        const limit = options.limit ?? 50;
        const maxPages = options.maxPages ?? 100;
        const allItems: T[] = [];
        let page = 1;

        while (page <= maxPages) {
            const items = await fetchPage(page, limit);
            allItems.push(...items);

            if (items.length < limit) {
                break;
            }
            page++;
        }

        return allItems;
    }
    private mapForgejoReviewComment(
        review: ForgejoPullReview,
        comment: {
            id?: number;
            body?: string;
            created_at?: string;
            updated_at?: string;
            user?: ForgejoUser;
            resolver?: ForgejoUser | null;
        },
    ): PullRequestReviewComment {
        return {
            id: comment.id,
            threadId: review.id?.toString(),
            isResolved: comment.resolver != null,
            isOutdated: review.stale ?? false,
            body: comment.body ?? '',
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
            author: {
                id: comment.user?.id?.toString() ?? '',
                username: comment.user?.login ?? '',
                name: comment.user?.full_name ?? comment.user?.login ?? '',
            },
        };
    }

    public async getAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ForgejoAuthDetail | null> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

            if (!integration?.authIntegration?.authDetails) {
                return null;
            }

            return integration.authIntegration.authDetails as ForgejoAuthDetail;
        } catch (error) {
            this.logger.error({
                message: 'Error getting auth details',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async findRepositoryByName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        name: string;
    }): Promise<Partial<Repository> | null> {
        try {
            const repositories = await this.getRepositories({
                organizationAndTeamData: params.organizationAndTeamData,
            });
            const wanted = params.name.trim().toLowerCase();
            const repo = repositories.find((r) => {
                const fullName = (
                    r.full_name || `${r.organizationName}/${r.name}`
                ).toLowerCase();

                return r.name.toLowerCase() === wanted || fullName === wanted;
            });
            if (!repo) {
                this.logger.warn({
                    message: 'Repository not found by name',
                    context: ForgejoService.name,
                    metadata: { repositoryName: params.name },
                });
                return null;
            }

            return {
                id: repo.id,
                name: repo.name,
                fullName:
                    repo.full_name || `${repo.organizationName}/${repo.name}`,
                defaultBranch: repo.default_branch,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error finding repository by name',
                context: ForgejoService.name,
                error,
                metadata: { repositoryName: params.name },
            });
            return null;
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
                }));
            const resolvedBaseBranch = baseBranch || resolvedTargetBranch;

            const authDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );

            if (!authDetail) {
                throw new Error('Authentication details not found');
            }

            const repoInfo = this.extractRepoInfo(
                repository.name,
                'createPullRequestWithFiles',
            );

            if (!repoInfo) {
                throw new Error('Invalid repository name format');
            }

            const client = this.createForgejoClient(authDetail);

            const uploadResult = await this.uploadFiles({
                organizationAndTeamData,
                repository,
                branchName: resolvedSourceBranch,
                baseBranch: resolvedBaseBranch,
                files,
                message: resolvedCommitMessage,
                author,
            });

            if (!uploadResult) {
                throw new BadRequestException(
                    'Failed to upload files to Forgejo',
                );
            }

            const pr = await repoCreatePullRequest({
                client,
                path: repoInfo,
                body: {
                    base: resolvedTargetBranch,
                    head: resolvedSourceBranch,
                    title: resolvedTitle,
                    body: description,
                },
            });

            if (!pr || pr.status >= 300) {
                throw new Error(`Failed to create pull request: ${pr.status}`);
            }

            return {
                id: pr.data?.id?.toString() ?? '',
                number: pr.data?.number ?? -1,
                title: pr.data?.title ?? '',
                prURL: pr.data?.html_url ?? '',
            };
        } catch (error) {
            this.logger.error({
                message: 'Error creating pull request with files',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return null;
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

            const authDetail = await this.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetail) {
                throw new Error('Authentication details not found');
            }

            const repoInfo = this.extractRepoInfo(
                repository.name,
                'uploadFiles',
            );

            if (!repoInfo) {
                throw new Error('Invalid repository name format');
            }

            const client = this.createForgejoClient(authDetail);

            const tokenAuthorIdentity =
                authDetail.authMode === AuthMode.TOKEN && author?.name
                    ? {
                          name: author.name,
                          email: author.email || 'kody@kodus.io',
                      }
                    : undefined;

            const branchAlreadyExists =
                resolvedBranchName === resolvedBaseBranch
                    ? true
                    : await this.checkForgejoBranchExists(
                          client,
                          repoInfo,
                          resolvedBranchName,
                      );

            const fileExistsReferenceBranch = branchAlreadyExists
                ? resolvedBranchName
                : resolvedBaseBranch;

            const fileExistsEntries = await Promise.all(
                files.map(async (file) => {
                    const exists = await this.checkForgejoFileExists(
                        client,
                        repoInfo,
                        fileExistsReferenceBranch,
                        file.path,
                    );

                    return [file.path, exists] as const;
                }),
            );

            const fileExistsByPath = new Map(fileExistsEntries);

            const changes = files
                .map((file) => {
                    const operation = file.operation || 'upsert';
                    const fileExists = fileExistsByPath.get(file.path) === true;

                    if (operation === 'delete') {
                        if (!fileExists) {
                            return null;
                        }

                        return {
                            operation: 'delete' as const,
                            path: file.path,
                        } as any;
                    }

                    if (typeof file.content !== 'string') {
                        throw new Error(
                            `File content is required for upsert operation: ${file.path}`,
                        );
                    }

                    return {
                        operation: fileExists
                            ? ('update' as const)
                            : ('create' as const),
                        path: file.path,
                        content: file.content,
                    } as any;
                })
                .filter((change): change is NonNullable<typeof change> =>
                    Boolean(change),
                );

            if (changes.length === 0) {
                return true;
            }

            const res = await repoChangeFiles({
                client,
                path: repoInfo,
                body: {
                    files: changes,
                    message: resolvedMessage,
                    branch: branchAlreadyExists
                        ? resolvedBranchName
                        : resolvedBaseBranch,
                    ...(tokenAuthorIdentity
                        ? {
                              author: tokenAuthorIdentity,
                              committer: tokenAuthorIdentity,
                          }
                        : {}),
                    ...(!branchAlreadyExists &&
                    resolvedBranchName !== resolvedBaseBranch
                        ? {
                              new_branch: resolvedBranchName,
                          }
                        : {}),
                },
            });

            if (!res || res.status >= 300) {
                throw new Error(`Failed to upload files: ${res.status}`);
            }

            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error uploading files to Forgejo',
                context: ForgejoService.name,
                error,
                metadata: { params },
            });
            return false;
        }
    }

    private async checkForgejoBranchExists(
        client: Client,
        repoInfo: { owner: string; repo: string },
        branchName: string,
    ): Promise<boolean> {
        try {
            await getTree({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    sha: branchName,
                },
                query: {
                    recursive: false,
                },
            });

            return true;
        } catch (error) {
            if (this.isForgejoNotFoundError(error)) {
                return false;
            }

            throw error;
        }
    }

    private async checkForgejoFileExists(
        client: Client,
        repoInfo: { owner: string; repo: string },
        branchName: string,
        filePath: string,
    ): Promise<boolean> {
        try {
            await repoGetContents({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    filepath: filePath.replace(/^\/+/, ''),
                },
                query: {
                    ref: branchName,
                },
            });

            return true;
        } catch (error) {
            if (this.isForgejoNotFoundError(error)) {
                return false;
            }

            throw error;
        }
    }

    private isForgejoNotFoundError(error: unknown): boolean {
        const candidate = error as
            | {
                  status?: number;
                  code?: number;
                  response?: { status?: number };
              }
            | undefined;

        const status =
            candidate?.status || candidate?.code || candidate?.response?.status;

        return status === 404;
    }

    private extractRepoInfo(
        repositoryName: string,
        methodName: string,
    ): { owner: string; repo: string } | null {
        const repoData = extractOwnerAndRepo(repositoryName);
        if (!repoData) {
            this.logger.error({
                message: `Could not parse repository name in ${methodName}`,
                context: ForgejoService.name,
                metadata: { repositoryName },
            });
            return null;
        }
        return repoData;
    }

    private mapPullRequestState(pr: ForgejoPullRequest): PullRequestState {
        if (pr.merged) return PullRequestState.MERGED;
        if (pr.state === 'closed') return PullRequestState.CLOSED;
        return PullRequestState.OPENED;
    }

    private transformPullRequest(
        pr: ForgejoPullRequest,
        repo:
            | Repositories
            | { id: string; name: string; default_branch?: string },
        organizationAndTeamData?: OrganizationAndTeamData,
    ): PullRequest {
        const state = this.mapPullRequestState(pr);
        const repoWithDefaults = {
            id: repo.id ?? '',
            name: repo.name ?? '',
            default_branch:
                ('default_branch' in repo ? repo.default_branch : undefined) ??
                '',
        };
        const repositoryFullName =
            pr.base?.repo?.full_name ?? repoWithDefaults.name;
        const baseRepositoryName = pr.base?.repo?.name ?? repoWithDefaults.name;

        return {
            id: pr.id?.toString() ?? '',
            number: pr.number ?? -1,
            pull_number: pr.number ?? -1,
            organizationId: organizationAndTeamData?.organizationId ?? '',
            title: pr.title ?? '',
            body: pr.body ?? '',
            state,
            prURL: pr.html_url ?? '',
            repository: repositoryFullName,
            repositoryId: repoWithDefaults.id,
            repositoryData: {
                id: repoWithDefaults.id,
                name: repositoryFullName,
            },
            message: pr.title ?? '',
            created_at: pr.created_at ?? '',
            closed_at: pr.closed_at ?? '',
            updated_at: pr.updated_at ?? '',
            merged_at: pr.merged_at ?? '',
            participants: pr.user?.id ? [{ id: pr.user.id.toString() }] : [],
            reviewers: [],
            sourceRefName: pr.head?.ref ?? '',
            head: {
                ref: pr.head?.ref ?? '',
                sha: pr.head?.sha,
                repo: {
                    id: pr.head?.repo?.id?.toString() ?? '',
                    name: pr.head?.repo?.name ?? '',
                    defaultBranch: pr.head?.repo?.default_branch ?? '',
                    fullName:
                        pr.head?.repo?.full_name ?? pr.head?.repo?.name ?? '',
                },
            },
            targetRefName: pr.base?.ref ?? '',
            base: {
                ref: pr.base?.ref ?? '',
                sha: pr.base?.sha,
                repo: {
                    id: repoWithDefaults.id,
                    name: baseRepositoryName,
                    defaultBranch: repoWithDefaults.default_branch,
                    fullName: repositoryFullName,
                },
            },
            user: {
                login: pr.user?.login || '',
                name: pr.user?.full_name || pr.user?.login || '',
                id: pr.user?.id?.toString() ?? '',
            },
            isDraft:
                pr.draft ||
                pr.title?.toLowerCase().startsWith('wip:') ||
                pr.title?.toLowerCase().startsWith('[wip]') ||
                pr.title?.toLowerCase().startsWith('draft:') ||
                pr.title?.toLowerCase().startsWith('[draft]') ||
                false,
        };
    }

    /**
     * Parses a unified diff string and extracts per-file patches.
     * Returns a map of filename -> patch content.
     */
    private parseUnifiedDiff(diffContent: string): Map<string, string> {
        const patchMap = new Map<string, string>();

        if (!diffContent) {
            return patchMap;
        }

        // Split by file diff headers (diff --git a/... b/...)
        const fileDiffs = diffContent.split(/(?=^diff --git )/m);

        for (const fileDiff of fileDiffs) {
            if (!fileDiff.trim()) continue;

            // Extract filename from the diff header
            // Format: diff --git a/path/to/file b/path/to/file
            const headerMatch = fileDiff.match(
                /^diff --git a\/(.+?) b\/(.+?)$/m,
            );
            if (!headerMatch) continue;

            // Use the 'b' path (new filename, handles renames)
            const filename = headerMatch[2];

            // Find where the actual patch starts (after the header lines)
            // The patch starts at the first @@ line
            const patchStartIndex = fileDiff.indexOf('@@');
            if (patchStartIndex === -1) {
                // No hunks - might be a binary file or mode change only
                patchMap.set(filename, '');
                continue;
            }

            // Extract just the patch part (from @@ onwards)
            const patch = fileDiff.substring(patchStartIndex);
            patchMap.set(filename, patch.trim());
        }

        return patchMap;
    }

    private transformCommit(commit: ForgejoCommit): Commit {
        return {
            sha: commit.sha,
            commit: {
                message: commit.commit?.message || '',
                author: {
                    name: commit.commit?.author?.name || '',
                    email: commit.commit?.author?.email || '',
                    date: commit.commit?.author?.date || '',
                },
            },
            parents: commit.parents?.map((p) => ({ sha: p.sha })),
        };
    }

    async createAuthIntegration(params: any): Promise<any> {
        return this.authenticateWithToken(params);
    }

    async authenticateWithToken(params: {
        token: string;
        host: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<{ success: boolean; status: CreateAuthIntegrationStatus }> {
        try {
            const { token, host, organizationAndTeamData } = params;

            if (!host) throw new Error('Forgejo host URL is required');
            if (!token) throw new Error('Forgejo access token is required');

            const normalizedHost = host.replace(/\/+$/, '');

            const authDetails: ForgejoAuthDetail = {
                accessToken: encrypt(token),
                authMode: AuthMode.TOKEN,
                host: normalizedHost,
            };

            const checkRepos = await this.checkRepositoryPermissions({
                authDetails,
            });
            if (!checkRepos.success) return checkRepos;

            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
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
            const errorMessage =
                err?.response?.data?.message || err?.message || 'Unknown error';
            this.logger.error({
                message: 'Error authenticating with Forgejo token',
                context: ForgejoService.name,
                error: err,
                metadata: { errorMessage },
            });
            throw new BadRequestException(
                `Error authenticating with Forgejo: ${errorMessage}`,
            );
        }
    }

    private async checkRepositoryPermissions(params: {
        authDetails: ForgejoAuthDetail;
    }): Promise<{ success: boolean; status: CreateAuthIntegrationStatus }> {
        try {
            const client = this.createForgejoClient(params.authDetails);

            const userReposResult = await userCurrentListRepos({
                client,
                query: { limit: 50 },
            });

            const userRepos = userReposResult.data ?? [];
            if (userRepos.length > 0) {
                return {
                    success: true,
                    status: CreateAuthIntegrationStatus.SUCCESS,
                };
            }

            const orgsResult = await orgListCurrentUserOrgs({
                client,
                query: { limit: 50 },
            });

            const orgs = orgsResult.data ?? [];
            for (const org of orgs) {
                const orgReposResult = await orgListRepos({
                    client,
                    path: { org: org.name! },
                    query: { limit: 10 },
                });
                const orgRepos = orgReposResult.data ?? [];
                if (orgRepos.length > 0) {
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
                message: 'Failed to check repository permissions',
                context: ForgejoService.name,
                error,
            });
            return {
                success: false,
                status: CreateAuthIntegrationStatus.NO_REPOSITORIES,
            };
        }
    }

    private async addAccessToken(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails: ForgejoAuthDetail,
    ): Promise<void> {
        const integrationUuid = uuidv4();
        const authIntegrationUuid = uuidv4();

        const newIntegration = await this.integrationService.create({
            uuid: integrationUuid,
            platform: PlatformType.FORGEJO,
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        await this.authIntegrationService.create({
            uuid: authIntegrationUuid,
            status: true,
            authDetails,
            integration: { uuid: newIntegration.uuid },
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });
    }

    async updateAuthIntegration(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        authIntegrationId: string;
        integrationId: string;
        authDetails: ForgejoAuthDetail;
    }): Promise<any> {
        await this.integrationService.update(
            {
                uuid: params.integrationId,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            },
            { status: true },
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
                authDetails: params.authDetails,
            },
        );
    }

    async createOrUpdateIntegrationConfig(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        configKey: IntegrationConfigKey;
        configValue: any;
        type?: 'replace' | 'append';
    }): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
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

            this.createPullRequestWebhook({
                organizationAndTeamData: params.organizationAndTeamData,
            });
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async findTeamAndOrganizationIdByConfigKey(params: {
        configKey: IntegrationConfigKey;
        configValue: any;
    }): Promise<IntegrationConfigEntity | null> {
        try {
            return await this.integrationConfigService.findOne({
                configKey: params.configKey,
                configValue: params.configValue,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error finding team and organization by config key',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    private async findOneByOrganizationAndTeamDataAndConfigKey(
        organizationAndTeamData: OrganizationAndTeamData,
        configKey: IntegrationConfigKey,
    ): Promise<any> {
        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            platform: PlatformType.FORGEJO,
        });

        if (!integration) return null;

        const config = await this.integrationConfigService.findOne({
            integration: { uuid: integration.uuid },
            configKey,
            team: { uuid: organizationAndTeamData.teamId },
        });

        return config?.configValue || null;
    }

    async verifyConnection(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<CodeManagementConnectionStatus> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );

            if (!authDetail) {
                return {
                    hasConnection: false,
                    isSetupComplete: false,
                    platformName: PlatformType.FORGEJO,
                    category: IntegrationCategory.CODE_MANAGEMENT,
                };
            }

            const client = this.createForgejoClient(authDetail);
            await userGetCurrent({ client });

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            return {
                hasConnection: true,
                isSetupComplete:
                    Array.isArray(repositories) && repositories.length > 0,
                platformName: PlatformType.FORGEJO,
                category: IntegrationCategory.CODE_MANAGEMENT,
                config: { repositories },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error verifying Forgejo connection',
                context: ForgejoService.name,
                error,
            });
            return {
                hasConnection: false,
                isSetupComplete: false,
                platformName: PlatformType.FORGEJO,
                category: IntegrationCategory.CODE_MANAGEMENT,
            };
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
            includePullRequestMetrics?: { lastNDays?: number };
        };
    }): Promise<Repositories[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createForgejoClient(authDetail);

            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.FORGEJO,
            });

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    team: { uuid: params.organizationAndTeamData.teamId },
                });

            const repositories: Repositories[] = [];
            const seenRepoIds = new Set<string>();

            const userRepos = await this.paginate<ForgejoRepository>(
                async (page, limit) => {
                    const result = await userCurrentListRepos({
                        client,
                        query: { page, limit },
                    });
                    return result.data ?? [];
                },
            );
            for (const repo of userRepos) {
                const repoId = repo.id!.toString();
                if (!seenRepoIds.has(repoId)) {
                    seenRepoIds.add(repoId);
                    repositories.push(
                        this.transformRepository(repo, integrationConfig),
                    );
                }
            }

            try {
                const orgs = await this.paginate<ForgejoOrganization>(
                    async (page, limit) => {
                        const result = await orgListCurrentUserOrgs({
                            client,
                            query: { page, limit },
                        });
                        return result.data ?? [];
                    },
                );
                for (const org of orgs) {
                    const orgReposResult =
                        await this.paginate<ForgejoRepository>(
                            async (page, limit) => {
                                const result = await orgListRepos({
                                    client,
                                    path: { org: org.name! },
                                    query: { page, limit },
                                });
                                return result.data ?? [];
                            },
                        );
                    for (const repo of orgReposResult) {
                        const repoId = repo.id!.toString();
                        if (!seenRepoIds.has(repoId)) {
                            seenRepoIds.add(repoId);
                            repositories.push(
                                this.transformRepository(
                                    repo,
                                    integrationConfig,
                                ),
                            );
                        }
                    }
                }
            } catch (error) {
                this.logger.warn({
                    message: 'Error fetching organization repositories',
                    context: ForgejoService.name,
                    error,
                });
            }

            return repositories;
        } catch (error) {
            this.logger.error({
                message: 'Error getting repositories',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    private transformRepository(
        repo: ForgejoRepository,
        integrationConfig?: IntegrationConfigEntity | null,
    ): Repositories {
        return {
            id: repo.id!.toString(),
            name: repo.full_name!,
            http_url: repo.clone_url,
            avatar_url: repo.avatar_url || repo.owner?.avatar_url,
            organizationName: repo.owner?.login,
            visibility: repo.private ? 'private' : 'public',
            selected: integrationConfig?.configValue?.some(
                (r: { name: string }) => r?.name === repo.full_name,
            ),
            default_branch: repo.default_branch,
            lastActivityAt: repo.updated_at,
        };
    }

    async getDefaultBranch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
    }): Promise<string> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return 'main';

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getDefaultBranch',
            );
            if (!repoInfo) return 'main';

            const client = this.createForgejoClient(authDetail);
            const result = await repoGet({
                client,
                path: { owner: repoInfo.owner, repo: repoInfo.repo },
            });
            return result.data?.default_branch || 'main';
        } catch (error) {
            this.logger.error({
                message: 'Error getting default branch',
                context: ForgejoService.name,
                error,
            });
            return 'main';
        }
    }

    async getLanguageRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
    }): Promise<string | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getLanguageRepository',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);
            const result = await repoGetLanguages({
                client,
                path: { owner: repoInfo.owner, repo: repoInfo.repo },
            });
            const languages = result.data as Record<string, number> | undefined;

            const sorted = Object.entries(languages ?? {}).sort(
                ([, a], [, b]) => b - a,
            );
            return sorted[0]?.[0] || null;
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository language',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getListMembers(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<{ name: string; id: string | number; type?: string }[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createForgejoClient(authDetail);

            const orgs = await this.paginate<ForgejoOrganization>(
                async (page, limit) => {
                    const result = await orgListCurrentUserOrgs({
                        client,
                        query: { page, limit },
                    });
                    return result.data ?? [];
                },
            );

            const allMembers: {
                name: string;
                id: string | number;
                type?: string;
            }[] = [];
            const seenIds = new Set<string>();

            for (const org of orgs) {
                if (!org.name) continue;

                try {
                    const members = await this.paginate<ForgejoUser>(
                        async (page, limit) => {
                            const result = await orgListMembers({
                                client,
                                path: { org: org.name! },
                                query: { page, limit },
                            });
                            return result.data ?? [];
                        },
                    );

                    for (const member of members) {
                        const memberId = member.id?.toString() ?? '';
                        if (!seenIds.has(memberId)) {
                            seenIds.add(memberId);
                            allMembers.push({
                                name: member.login ?? member.full_name ?? '',
                                id: member.id ?? '',
                                type: member.is_admin ? 'admin' : 'user',
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching members for org ${org.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return allMembers;
        } catch (error) {
            this.logger.error({
                message: 'Error getting list members',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getCloneParams(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: {
            id?: string;
            name: string;
            fullName?: string;
            defaultBranch?: string;
        };
    }): Promise<GitCloneParams> {
        const authDetail = await this.getAuthDetails(
            params.organizationAndTeamData,
        );
        if (!authDetail) {
            throw new Error('No auth details found');
        }

        const repositoryFullName =
            params.repository.fullName || params.repository.name;

        const repoInfo = this.extractRepoInfo(
            repositoryFullName,
            'getCloneParams',
        );
        if (!repoInfo) {
            throw new Error('Invalid repository name');
        }

        const token = decrypt(authDetail.accessToken);
        const cloneUrl = `${authDetail.host}/${repositoryFullName}.git`;

        return {
            url: cloneUrl,
            provider: PlatformType.FORGEJO,
            organizationId: params.organizationAndTeamData.organizationId,
            repositoryId: params.repository.id || repoInfo.repo,
            repositoryName: repoInfo.repo,
            branch: params.repository.defaultBranch,
            auth: {
                type: authDetail.authMode,
                username: 'oauth2',
                token,
            },
        };
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
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createForgejoClient(authDetail);
            const pullRequests: PullRequest[] = [];

            let repositories = params.repository
                ? [params.repository]
                : await this.findOneByOrganizationAndTeamDataAndConfigKey(
                      params.organizationAndTeamData,
                      IntegrationConfigKey.REPOSITORIES,
                  );

            if (!repositories || !Array.isArray(repositories)) {
                repositories = [];
            }

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'getPullRequests',
                );
                if (!repoInfo) continue;

                try {
                    const state = this.mapStateToForgejoState(
                        params.filters?.state,
                    );
                    const prs = await this.paginate<ForgejoPullRequest>(
                        async (page, limit) => {
                            const result = await repoListPullRequests({
                                client,
                                path: {
                                    owner: repoInfo.owner,
                                    repo: repoInfo.repo,
                                },
                                query: { state, page, limit },
                            });
                            return result.data ?? [];
                        },
                    );

                    for (const pr of prs) {
                        const transformed = this.transformPullRequest(pr, repo);

                        if (
                            params.filters?.startDate &&
                            new Date(pr.created_at!) < params.filters.startDate
                        )
                            continue;
                        if (
                            params.filters?.endDate &&
                            new Date(pr.created_at!) > params.filters.endDate
                        )
                            continue;
                        if (
                            params.filters?.author &&
                            pr.user?.login !== params.filters.author
                        )
                            continue;
                        if (
                            params.filters?.branch &&
                            pr.head?.ref !== params.filters.branch
                        )
                            continue;

                        pullRequests.push(transformed);
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching PRs for repository ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return pullRequests;
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull requests',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    private mapStateToForgejoState(
        state?: PullRequestState,
    ): 'open' | 'closed' | 'all' {
        if (!state) return 'all';
        if (state === PullRequestState.OPENED) return 'open';
        return 'closed';
    }

    async getPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequest | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) {
                this.logger.warn({
                    message: 'No auth details found for getPullRequest',
                    context: ForgejoService.name,
                    metadata: {
                        prNumber: params.prNumber,
                        repository: params.repository.name,
                    },
                });
                return null;
            }

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getPullRequest',
            );
            if (!repoInfo) {
                this.logger.warn({
                    message: 'Could not extract repo info for getPullRequest',
                    context: ForgejoService.name,
                    metadata: {
                        prNumber: params.prNumber,
                        repository: params.repository.name,
                    },
                });
                return null;
            }

            const client = this.createForgejoClient(authDetail);
            const result = await repoGetPullRequest({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
            });

            if (result.error) {
                this.logger.warn({
                    message: 'Forgejo API error getting pull request',
                    context: ForgejoService.name,
                    metadata: {
                        prNumber: params.prNumber,
                        repository: params.repository.name,
                        error: result.error,
                    },
                });
                return null;
            }

            if (!result.data) return null;

            return this.transformPullRequest(result.data, {
                id: params.repository.id || '',
                name: params.repository.name!,
            });
        } catch (error) {
            if ((error as any)?.status === 404) {
                return null;
            }
            this.logger.error({
                message: 'Error getting pull request',
                context: ForgejoService.name,
                error,
                metadata: { prNumber: params.prNumber },
            });
            return null;
        }
    }

    async getPullRequestByNumber(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id?: string };
        prNumber: number;
    }): Promise<PullRequest | null> {
        return this.getPullRequest(params);
    }

    async getPullRequestsByRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
    }): Promise<PullRequest[]> {
        return this.getPullRequests({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
        });
    }

    async getPullRequestsWithFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { id: string; name: string };
        filters?: { state?: PullRequestState };
    }): Promise<PullRequestWithFiles[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const client = this.createForgejoClient(authDetail);
            const result: PullRequestWithFiles[] = [];

            const repositories = params.repository
                ? [params.repository]
                : await this.findOneByOrganizationAndTeamDataAndConfigKey(
                      params.organizationAndTeamData,
                      IntegrationConfigKey.REPOSITORIES,
                  );

            if (!repositories) return null;

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'getPullRequestsWithFiles',
                );
                if (!repoInfo) continue;

                try {
                    const state = this.mapStateToForgejoState(
                        params.filters?.state,
                    );
                    const prs = await this.paginate<ForgejoPullRequest>(
                        async (page, limit) => {
                            const res = await repoListPullRequests({
                                client,
                                path: {
                                    owner: repoInfo.owner,
                                    repo: repoInfo.repo,
                                },
                                query: { state, page, limit },
                            });
                            return res.data ?? [];
                        },
                    );

                    for (const pr of prs) {
                        const files = await this.paginate<ForgejoChangedFile>(
                            async (page, limit) => {
                                const res = await repoGetPullRequestFiles({
                                    client,
                                    path: {
                                        owner: repoInfo.owner,
                                        repo: repoInfo.repo,
                                        index: pr.number!,
                                    },
                                    query: { page, limit },
                                });
                                return res.data ?? [];
                            },
                        );
                        result.push({
                            id: pr.id,
                            pull_number: pr.number,
                            state: pr.state || 'open',
                            title: pr.title || '',
                            repository: repo.name,
                            repositoryData: {
                                platform: 'forgejo',
                                id: repo.id || '',
                                name: repo.name,
                                fullName: repo.name,
                                language: repo.language || '',
                                defaultBranch: repo.default_branch || 'main',
                            },
                            pullRequestFiles: files.map((f) => ({
                                additions: f.additions,
                                deletions: f.deletions,
                                changes: f.changes,
                                status: f.status,
                            })),
                        });
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching PRs with files for ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error getting pull requests with files',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestsForRTTM(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: {
            period?: {
                startDate?: Date;
                endDate?: Date;
            };
        };
    }): Promise<PullRequestCodeReviewTime[] | null> {
        try {
            if (!params?.organizationAndTeamData.organizationId) {
                return null;
            }

            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );
            if (!repositories) return null;

            const client = this.createForgejoClient(authDetail);

            const { startDate, endDate } = params?.filters?.period || {};
            const pullRequestCodeReviewTime: PullRequestCodeReviewTime[] = [];

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'getPullRequestsForRTTM',
                );
                if (!repoInfo) continue;

                try {
                    const prs = await this.paginate<ForgejoPullRequest>(
                        async (page, limit) => {
                            const result = await repoListPullRequests({
                                client,
                                path: {
                                    owner: repoInfo.owner,
                                    repo: repoInfo.repo,
                                },
                                query: { state: 'closed', page, limit },
                            });
                            return result.data ?? [];
                        },
                    );

                    for (const pr of prs) {
                        if (startDate && pr.created_at) {
                            if (new Date(pr.created_at) < startDate) continue;
                        }
                        if (endDate && pr.created_at) {
                            if (new Date(pr.created_at) > endDate) continue;
                        }

                        pullRequestCodeReviewTime.push({
                            id: pr.id ?? 0,
                            created_at: pr.created_at ?? '',
                            closed_at: pr.closed_at ?? '',
                        });
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching PRs for RTTM from ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return pullRequestCodeReviewTime;
        } catch (error) {
            this.logger.error({
                message: 'Error getting PRs for RTTM',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getFilesByPullRequestId(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
    }): Promise<any[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getFilesByPullRequestId',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);

            // Fetch file metadata and diff in parallel
            const [files, diffResult] = await Promise.all([
                this.paginate<ForgejoChangedFile>(async (page, limit) => {
                    const result = await repoGetPullRequestFiles({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                        },
                        query: { page, limit },
                    });
                    return result.data ?? [];
                }),
                repoDownloadPullDiffOrPatch({
                    client,
                    path: {
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                        index: params.prNumber,
                        diffType: 'diff',
                    },
                }).catch((error) => {
                    this.logger.warn({
                        message: `Failed to fetch diff for PR#${params.prNumber}, continuing without patch data`,
                        context: ForgejoService.name,
                        error,
                    });
                    return { data: '' };
                }),
            ]);

            const diffContent = (diffResult.data as string) ?? '';

            // Parse the unified diff to extract per-file patches
            const patchMap = this.parseUnifiedDiff(diffContent);

            this.logger.log({
                message: `Fetched ${files.length} files with ${patchMap.size} patches for PR#${params.prNumber}`,
                context: ForgejoService.name,
                metadata: {
                    filesCount: files.length,
                    patchesCount: patchMap.size,
                    prNumber: params.prNumber,
                },
            });

            return files.map((f) => ({
                sha: '',
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: patchMap.get(f.filename ?? '') ?? '',
                previous_filename: f.previous_filename,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting files by PR ID',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getChangedFilesSinceLastCommit(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        lastCommitSha: string;
    }): Promise<any | null> {
        // For simplicity, return all files - Forgejo doesn't have easy diff between commits
        return this.getFilesByPullRequestId(params);
    }

    async isDraftPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<boolean> {
        try {
            const pr = await this.getPullRequest(params);
            return pr?.isDraft || false;
        } catch {
            return false;
        }
    }

    async getPullRequestAuthors(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        determineBots?: boolean;
    }): Promise<PullRequestAuthor[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createForgejoClient(authDetail);
            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) return [];

            const authorsMap = new Map<string, PullRequestAuthor>();

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'getPullRequestAuthors',
                );
                if (!repoInfo) continue;

                try {
                    const prs = await this.paginate<ForgejoPullRequest>(
                        async (page, limit) => {
                            const result = await repoListPullRequests({
                                client,
                                path: {
                                    owner: repoInfo.owner,
                                    repo: repoInfo.repo,
                                },
                                query: { state: 'all', page, limit },
                            });
                            return result.data ?? [];
                        },
                    );

                    for (const pr of prs) {
                        if (
                            pr.user?.id &&
                            !authorsMap.has(pr.user.id.toString())
                        ) {
                            authorsMap.set(pr.user.id.toString(), {
                                id: pr.user.id.toString(),
                                name: pr.user.full_name || pr.user.login || '',
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching PR authors for ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return Array.from(authorsMap.values());
        } catch (error) {
            this.logger.error({
                message: 'Error getting PR authors',
                context: ForgejoService.name,
                error,
            });
            return [];
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
    }): Promise<Commit[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createForgejoClient(authDetail);
            const commits: Commit[] = [];

            const repositories = params.repository
                ? [params.repository]
                : await this.findOneByOrganizationAndTeamDataAndConfigKey(
                      params.organizationAndTeamData,
                      IntegrationConfigKey.REPOSITORIES,
                  );

            if (!repositories) return [];

            for (const repo of repositories) {
                if (!repo.name) continue;
                const repoInfo = this.extractRepoInfo(repo.name, 'getCommits');
                if (!repoInfo) continue;

                try {
                    const repoCommits = await this.paginate<ForgejoCommit>(
                        async (page, limit) => {
                            const result = await repoGetAllCommits({
                                client,
                                path: {
                                    owner: repoInfo.owner,
                                    repo: repoInfo.repo,
                                },
                                query: {
                                    sha: params.filters?.branch,
                                    page,
                                    limit,
                                },
                            });
                            return result.data ?? [];
                        },
                    );

                    for (const commit of repoCommits) {
                        const transformed = this.transformCommit(commit);

                        const commitDate = new Date(
                            commit.commit?.author?.date || '',
                        );
                        if (
                            params.filters?.startDate &&
                            commitDate < params.filters.startDate
                        )
                            continue;
                        if (
                            params.filters?.endDate &&
                            commitDate > params.filters.endDate
                        )
                            continue;
                        if (
                            params.filters?.author &&
                            commit.commit?.author?.name !==
                                params.filters.author
                        )
                            continue;

                        commits.push(transformed);
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error fetching commits for ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }

            return commits;
        } catch (error) {
            this.logger.error({
                message: 'Error getting commits',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getCommitsForPullRequestForCodeReview(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
    }): Promise<Commit[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getCommitsForPullRequestForCodeReview',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);
            const commits = await this.paginate<ForgejoCommit>(
                async (page, limit) => {
                    const result = await repoGetPullRequestCommits({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                        },
                        query: { page, limit },
                    });
                    return result.data ?? [];
                },
            );

            return commits
                .map((c) => this.transformCommit(c))
                .sort(
                    (a, b) =>
                        new Date(a?.commit?.author?.date || '').getTime() -
                        new Date(b?.commit?.author?.date || '').getTime(),
                );
        } catch (error) {
            this.logger.error({
                message: 'Error getting commits for PR',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async mergePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        mergeMethod?: 'merge' | 'squash' | 'rebase';
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) throw new Error('No auth details');

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'mergePullRequest',
            );
            if (!repoInfo) throw new Error('Invalid repository name');

            const client = this.createForgejoClient(authDetail);

            const mergeMethodMap: Record<
                string,
                'merge' | 'squash' | 'rebase'
            > = {
                merge: 'merge',
                squash: 'squash',
                rebase: 'rebase',
            };

            await repoMergePullRequest({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
                body: {
                    Do:
                        mergeMethodMap[params.mergeMethod || 'merge'] ||
                        'merge',
                },
            });

            return { success: true };
        } catch (error) {
            this.logger.error({
                message: 'Error merging pull request',
                context: ForgejoService.name,
                error,
            });
            throw error;
        }
    }

    async approvePullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body?: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) throw new Error('No auth details');

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'approvePullRequest',
            );
            if (!repoInfo) throw new Error('Invalid repository name');

            const client = this.createForgejoClient(authDetail);

            const result = await repoCreatePullReview({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
                body: {
                    event: 'APPROVED',
                    body: params.body || '',
                },
            });

            return result.data;
        } catch (error) {
            this.logger.error({
                message: 'Error approving pull request',
                context: ForgejoService.name,
                error,
            });
            throw error;
        }
    }

    async requestChangesPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
        criticalComments: CommentResult[];
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) throw new Error('No auth details');

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'requestChangesPullRequest',
            );
            if (!repoInfo) throw new Error('Invalid repository name');

            const client = this.createForgejoClient(authDetail);

            const listOfCriticalIssues = this.getListOfCriticalIssues({
                criticalComments: params.criticalComments,
                repository: params.repository,
                prNumber: params.prNumber,
                forgejoHost: authDetail.host,
            });

            const requestChangeBodyTitle =
                '# Found critical issues please review the requested changes';

            const formattedBody =
                `${requestChangeBodyTitle}\n\n${listOfCriticalIssues}`.trim();

            const result = await repoCreatePullReview({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
                body: {
                    event: 'REQUEST_CHANGES',
                    body: formattedBody,
                },
            });

            this.logger.log({
                message: `Changed status to requested changes on pull request #${params.prNumber}`,
                context: ForgejoService.name,
                metadata: params,
            });

            return result.data;
        } catch (error) {
            this.logger.error({
                message: `Error to change status to request changes on pull request #${params.prNumber}`,
                context: ForgejoService.name,
                error,
                metadata: params,
            });
            throw error;
        }
    }

    private getListOfCriticalIssues(params: {
        criticalComments: CommentResult[];
        repository: Partial<Repository>;
        prNumber: number;
        forgejoHost?: string;
    }): string {
        const { criticalComments, prNumber, repository, forgejoHost } = params;

        const repositoryFullName = repository.fullName || repository.name;
        const forgejoBaseUrl = forgejoHost?.replace(/\/+$/, '');
        const criticalIssuesSummaryArray =
            this.getCriticalIssuesSummaryArray(criticalComments);

        return criticalIssuesSummaryArray
            .map((criticalIssue) => {
                const commentId = criticalIssue.id;
                const summary = criticalIssue.oneSentenceSummary;
                const link =
                    !forgejoBaseUrl ||
                    !repositoryFullName ||
                    !prNumber ||
                    !commentId
                        ? ''
                        : `${forgejoBaseUrl}/${repositoryFullName}/pulls/${prNumber}#issuecomment-${commentId}`;

                return commentId ? `- [${summary}](${link})` : `- ${summary}`;
            })
            .join('\n');
    }

    private getCriticalIssuesSummaryArray(
        criticalComments: CommentResult[],
    ): OneSentenceSummaryItem[] {
        return criticalComments.map((comment) => ({
            id: comment.codeReviewFeedbackData?.commentId,
            oneSentenceSummary:
                comment.comment?.suggestion?.oneSentenceSummary ?? '',
        }));
    }

    async getOrganizations(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<Organization[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const client = this.createForgejoClient(authDetail);

            const orgs = await this.paginate<ForgejoOrganization>(
                async (page, limit) => {
                    const result = await orgListCurrentUserOrgs({
                        client,
                        query: { page, limit },
                    });
                    return result.data ?? [];
                },
            );

            return orgs.map((org) => ({
                id: org.id?.toString() ?? '',
                name: org.name ?? org.username ?? '',
                url: org.avatar_url ?? '',
                selected: false,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting organizations',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getListOfValidReviews(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getListOfValidReviews',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);

            const reviews = await this.paginate<ForgejoPullReview>(
                async (page, limit) => {
                    const result = await repoListPullReviews({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                        },
                        query: { page, limit },
                    });
                    return result.data ?? [];
                },
            );

            const reviewsWithComments = await Promise.all(
                reviews.map(async (review) => {
                    if (!review.id) return { ...review, comments: [] };

                    try {
                        const commentsResult = await repoGetPullReviewComments({
                            client,
                            path: {
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                                index: params.prNumber,
                                id: review.id,
                            },
                        });
                        const comments = commentsResult.data ?? [];

                        return {
                            state: review.state,
                            id: review.id?.toString(),
                            comments: comments.map((c) => ({
                                id: c.id?.toString(),
                                body: c.body,
                                outdated: false, // Forgejo doesn't have outdated concept
                                isMinimized: false, // Forgejo doesn't have minimize concept
                            })),
                        };
                    } catch {
                        return {
                            state: review.state,
                            id: review.id?.toString(),
                            comments: [],
                        };
                    }
                }),
            );

            return reviewsWithComments;
        } catch (error) {
            this.logger.error({
                message: 'Error getting list of valid reviews',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestsWithChangesRequested(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
    }): Promise<PullRequestsWithChangesRequested[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getPullRequestsWithChangesRequested',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);

            const prs = await this.paginate<ForgejoPullRequest>(
                async (page, limit) => {
                    const result = await repoListPullRequests({
                        client,
                        path: { owner: repoInfo.owner, repo: repoInfo.repo },
                        query: { state: 'open', page, limit },
                    });
                    return result.data ?? [];
                },
            );

            const result: PullRequestsWithChangesRequested[] = [];

            for (const pr of prs) {
                if (!pr.number) continue;

                try {
                    const reviews = await this.paginate<ForgejoPullReview>(
                        async (page, limit) => {
                            const res = await repoListPullReviews({
                                client,
                                path: {
                                    owner: repoInfo.owner,
                                    repo: repoInfo.repo,
                                    index: pr.number!,
                                },
                                query: { page, limit },
                            });
                            return res.data ?? [];
                        },
                    );

                    const latestReview = reviews[reviews.length - 1];
                    if (latestReview?.state === 'REQUEST_CHANGES') {
                        result.push({
                            title: pr.title || '',
                            number: pr.number,
                            reviewDecision:
                                PullRequestReviewState.CHANGES_REQUESTED,
                        });
                    }
                } catch {
                    // Skip PRs we can't get reviews for
                }
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error getting PRs with changes requested',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getPullRequestReviewThreads(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        // Forgejo doesn't have true review threads like GitHub
        // Return review comments grouped by their review instead
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getPullRequestReviewThreads',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);

            const reviews = await this.paginate<ForgejoPullReview>(
                async (page, limit) => {
                    const result = await repoListPullReviews({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                        },
                        query: { page, limit },
                    });
                    return result.data ?? [];
                },
            );

            const allComments: PullRequestReviewComment[] = [];

            for (const review of reviews) {
                if (!review.id) continue;

                try {
                    const commentsResult = await repoGetPullReviewComments({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                            id: review.id,
                        },
                    });
                    const comments = commentsResult.data ?? [];

                    for (const c of comments) {
                        allComments.push(
                            this.mapForgejoReviewComment(review, c),
                        );
                    }
                } catch {
                    // Skip reviews we can't get comments for
                }
            }

            return allComments;
        } catch (error) {
            this.logger.error({
                message: 'Error getting PR review threads',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async updateDescriptionInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        summary?: string;
        body?: string;
    }): Promise<any> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'updateDescriptionInPullRequest',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);

            // Truncate at the adapter boundary so the per-platform limit
            // is enforced consistently — see fit-pr-description.ts.
            const description = fitPRDescription(
                params.summary ?? params.body ?? '',
                PlatformType.FORGEJO,
            );

            const result = await repoEditPullRequest({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
                body: {
                    body: description,
                },
            });

            return result.data;
        } catch (error) {
            this.logger.error({
                message: 'Error updating PR description',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async checkIfPullRequestShouldBeApproved(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        repository: { id: string; name: string };
    }): Promise<{ shouldApprove: boolean; reason?: string } | null> {
        try {
            const pr = await this.getPullRequest({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
            });

            if (!pr) return null;

            return {
                shouldApprove:
                    pr.state === PullRequestState.OPENED && !pr.isDraft,
                reason: pr.isDraft ? 'PR is a draft' : undefined,
            };
        } catch (error) {
            return null;
        }
    }

    async getReviewStatusByPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewState | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getReviewStatusByPullRequest',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);
            const reviews = await this.paginate<ForgejoPullReview>(
                async (page, limit) => {
                    const result = await repoListPullReviews({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                        },
                        query: { page, limit },
                    });
                    return result.data ?? [];
                },
            );

            if (reviews.length === 0) return null;

            const latestReview = reviews[reviews.length - 1];

            switch (latestReview.state) {
                case 'APPROVED':
                    return PullRequestReviewState.APPROVED;
                case 'REQUEST_CHANGES':
                    return PullRequestReviewState.CHANGES_REQUESTED;
                case 'COMMENT':
                    return PullRequestReviewState.COMMENTED;
                default:
                    return PullRequestReviewState.PENDING;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error getting review status',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; language?: string };
        prNumber: number;
        lineComment: any;
        commit?: { sha: string };
        language?: LanguageValue;
        suggestionCopyPrompt?: boolean;
    }): Promise<ReviewComment | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'createReviewComment',
            );
            if (!repoInfo) return null;

            const { lineComment, commit, language, suggestionCopyPrompt } =
                params;

            const translations = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.ReviewComment,
            );

            const bodyFormatted = this.formatBodyForForgejo(
                lineComment,
                params.repository,
                translations,
                suggestionCopyPrompt ?? true,
            );

            const endLine = lineComment.line;

            this.logger.log({
                message: `Creating review comment for PR#${params.prNumber}`,
                context: ForgejoService.name,
                metadata: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    prNumber: params.prNumber,
                    path: lineComment.path,
                    line: endLine,
                    commitSha: commit?.sha?.substring(0, 7),
                },
            });

            const client = this.createForgejoClient(authDetail);
            const result = await repoCreatePullReview({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
                body: {
                    body: '',
                    commit_id: commit?.sha,
                    event: 'COMMENT',
                    comments: [
                        {
                            path: lineComment.path,
                            body: bodyFormatted,
                            new_position: endLine,
                        },
                    ],
                },
            });
            const review = result.data;
            const createdComment = review?.comments?.[0];

            this.logger.log({
                message: `Created review comment for PR#${params.prNumber}`,
                context: ForgejoService.name,
                metadata: {
                    reviewId: review?.id,
                    commentId: createdComment?.id,
                },
            });

            return {
                id: createdComment?.id ?? review?.id,
                pullRequestReviewId: review?.id?.toString(),
                body: createdComment?.body ?? bodyFormatted,
                createdAt: createdComment?.created_at ?? review?.submitted_at,
                updatedAt: createdComment?.updated_at ?? review?.submitted_at,
            };
        } catch (error: any) {
            const isLineMismatch =
                error.responseData?.message?.includes('line') ||
                error.responseData?.message?.includes('position');

            const errorType = isLineMismatch
                ? 'failed_lines_mismatch'
                : 'failed';

            this.logger.error({
                message: `Error creating review comment for PR#${params.prNumber}`,
                context: ForgejoService.name,
                error,
                metadata: { errorType },
            });

            throw { ...error, errorType };
        }
    }

    private formatBodyForForgejo(
        lineComment: any,
        repository: any,
        translations: any,
        suggestionCopyPrompt: boolean,
    ): string {
        const improvedCode = lineComment?.body?.improvedCode;
        const language =
            lineComment?.suggestion?.language?.toLowerCase() ||
            repository?.language?.toLowerCase() ||
            '';

        const severityShield = lineComment?.suggestion
            ? getSeverityLevelShield(lineComment.suggestion.severity)
            : '';

        const codeBlock = improvedCode
            ? `\n\`\`\`${language}\n${improvedCode}\n\`\`\`\n`
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

        const formatSub = (text: string) =>
            text ? `<sub>${text}</sub>\n` : '';

        return [
            badges,
            suggestionContent,
            actionStatement,
            codeBlock,
            copyPrompt,
            formatSub(translations?.talkToKody || ''),
            formatSub(translations?.feedback || '') +
                '<!-- kody-codereview -->&#8203;\n&#8203;',
        ]
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    private formatPromptForLLM(lineComment: any): string {
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

            copyPrompt = `\n<details>\n<summary>Prompt for LLM</summary>\n\n\`\`\`\n${copyPrompt}\n\`\`\`\n</details>\n`;
        }

        return copyPrompt;
    }

    async formatReviewCommentBody(params: {
        suggestion: any;
        repository: { name: string; language: string };
        includeHeader?: boolean;
        includeFooter?: boolean;
        language?: string;
        organizationAndTeamData: OrganizationAndTeamData;
        suggestionCopyPrompt?: boolean;
    }): Promise<string> {
        const translations = getTranslationsForLanguageByCategory(
            (params.language || 'en') as LanguageValue,
            TranslationsCategory.ReviewComment,
        );

        return this.formatBodyForForgejo(
            { suggestion: params.suggestion, body: params.suggestion },
            params.repository,
            translations,
            params.suggestionCopyPrompt ?? true,
        );
    }

    async createCommentInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body: string;
    }): Promise<any[] | null> {
        try {
            const result = await this.createIssueComment(params);
            return result ? [result] : null;
        } catch (error) {
            this.logger.error({
                message: 'Error creating comment in PR',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'createIssueComment',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);
            const result = await issueCreateComment({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
                body: { body: params.body },
            });

            return result.data;
        } catch (error) {
            this.logger.error({
                message: 'Error creating issue comment',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createSingleIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        body: string;
    }): Promise<any | null> {
        return this.createIssueComment(params);
    }

    async updateIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        commentId: number;
        body: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'updateIssueComment',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);
            const result = await issueEditComment({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    id: params.commentId,
                },
                body: { body: params.body },
            });

            return result.data;
        } catch (error) {
            this.logger.error({
                message: 'Error updating issue comment',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getAllCommentsInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
    }): Promise<any[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getAllCommentsInPullRequest',
            );
            if (!repoInfo) return [];

            const client = this.createForgejoClient(authDetail);
            const result = await issueGetComments({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
            });

            return result.data ?? [];
        } catch (error) {
            this.logger.error({
                message: 'Error getting all comments in PR',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getPullRequestReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
        commentId: number;
    }): Promise<any | null> {
        try {
            const comments = await this.getPullRequestReviewComments({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params.prNumber,
            });

            return comments?.find((c) => c.id === params.commentId) || null;
        } catch (error) {
            return null;
        }
    }

    async getPullRequestReviewComments(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<PullRequestReviewComment[] | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name!,
                'getPullRequestReviewComments',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);

            const reviews = await this.paginate<ForgejoPullReview>(
                async (page, limit) => {
                    const result = await repoListPullReviews({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                        },
                        query: { page, limit },
                    });
                    return result.data ?? [];
                },
            );

            const allComments: PullRequestReviewComment[] = [];
            for (const review of reviews) {
                if (!review.id) continue;
                try {
                    const commentsResult = await repoGetPullReviewComments({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            index: params.prNumber,
                            id: review.id,
                        },
                    });
                    const comments = commentsResult.data ?? [];
                    for (const c of comments) {
                        if (hasKodyMarker(c.body)) continue;

                        allComments.push(
                            this.mapForgejoReviewComment(review, c),
                        );
                    }
                } catch (reviewError) {
                    this.logger.warn({
                        message: `Error fetching comments for review ${review.id}`,
                        context: ForgejoService.name,
                        error: reviewError,
                    });
                }
            }

            return allComments;
        } catch (error) {
            this.logger.error({
                message: 'Error getting PR review comments',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async createResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        inReplyToId?: string;
        commentId?: string;
        body: string;
    }): Promise<any | null> {
        // Forgejo doesn't support threaded replies to review comments
        // Create a regular issue comment instead
        return this.createIssueComment({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: { name: params.repository.name! },
            prNumber: params.prNumber,
            body: params.body,
        });
    }

    async updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        parentId: string;
        commentId: string;
        body: string;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<any | null> {
        return this.updateIssueComment({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: { name: params.repository.name! },
            commentId: parseInt(params.commentId, 10),
            body: params.body,
        });
    }

    async getRepositoryContentFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        path: string;
        ref?: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getRepositoryContentFile',
            );
            if (!repoInfo) return null;

            const client = this.createForgejoClient(authDetail);
            const result = await repoGetContents({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    filepath: params.path,
                },
                query: { ref: params.ref },
            });
            const content = result.data;

            if (Array.isArray(content)) return null;

            const decodedContent =
                content?.encoding === 'base64'
                    ? Buffer.from(content.content || '', 'base64').toString(
                          'utf-8',
                      )
                    : content?.content;

            return {
                name: content?.name,
                path: content?.path,
                sha: content?.sha,
                size: content?.size,
                type: content?.type,
                content: decodedContent,
                encoding: 'utf-8',
                html_url: content?.html_url,
                download_url: content?.download_url,
            };
        } catch (error) {
            if ((error as any)?.status === 404) {
                return null;
            }
            this.logger.error({
                message: 'Error getting file content',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<TreeItem[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            const repo = repositories?.find(
                (r: any) => r.id === params.repositoryId,
            );
            if (!repo) return [];

            const repoInfo = this.extractRepoInfo(
                repo.name,
                'getRepositoryTree',
            );
            if (!repoInfo) return [];

            const client = this.createForgejoClient(authDetail);

            const repoResult = await repoGet({
                client,
                path: { owner: repoInfo.owner, repo: repoInfo.repo },
            });
            const defaultBranch = repoResult.data?.default_branch || 'main';

            const treeResult = await getTree({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    sha: defaultBranch,
                },
                query: { recursive: true },
            });
            const tree = treeResult.data;

            return (tree?.tree || []).map((item) => ({
                path: item.path,
                type:
                    item.type === 'blob'
                        ? ('file' as const)
                        : ('directory' as const),
                sha: item.sha,
                size: item.size,
                url: item.url || '',
                hasChildren: item.type !== 'blob',
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree',
                context: ForgejoService.name,
                error,
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
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            const repo = repositories?.find(
                (r: any) => r.id === params.repositoryId,
            );
            if (!repo) return [];

            const repoInfo = this.extractRepoInfo(
                repo.name,
                'getRepositoryTreeByDirectory',
            );
            if (!repoInfo) return [];

            const client = this.createForgejoClient(authDetail);

            const path = params.directoryPath || '';
            const result = await repoGetContents({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    filepath: path,
                },
            });

            const contents = result.data;
            if (!Array.isArray(contents)) {
                return [];
            }

            return contents.map((item) => ({
                path: item.path,
                type:
                    item.type === 'file'
                        ? ('file' as const)
                        : ('directory' as const),
                sha: item.sha,
                size: item.size,
                url: item.html_url || item.download_url || '',
                hasChildren: item.type !== 'file',
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting repository tree by directory',
                context: ForgejoService.name,
                error,
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
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'getRepositoryAllFiles',
            );
            if (!repoInfo) return [];

            const client = this.createForgejoClient(authDetail);

            const branch = params.filters?.branch || 'main';
            const result = await getTree({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    sha: branch,
                },
                query: { recursive: true },
            });

            const tree = result.data;
            let files = (tree?.tree || [])
                .filter((item) => item.type === 'blob')
                .map((item) => ({
                    path: item.path,
                    type: 'file',
                    filename: item.path?.split('/').pop() || item.path || '',
                    sha: item.sha,
                    size: item.size || 0,
                }));

            if (params.filters?.filePatterns?.length) {
                files = files.filter((f) =>
                    isFileMatchingGlobCaseInsensitive(
                        f.path,
                        params.filters!.filePatterns!,
                    ),
                );
            }

            if (params.filters?.excludePatterns?.length) {
                files = files.filter(
                    (f) =>
                        !isFileMatchingGlob(
                            f.path,
                            params.filters!.excludePatterns!,
                        ),
                );
            }

            if (params.filters?.maxFiles) {
                files = files.slice(0, params.filters.maxFiles);
            }

            return files;
        } catch (error) {
            this.logger.error({
                message: 'Error getting all repository files',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getUserByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        username: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const client = this.createForgejoClient(authDetail);
            const result = await userGet({
                client,
                path: { username: params.username },
            });

            const user = result.data;
            return {
                id: user!.id!.toString(),
                login: user!.login,
                name: user!.full_name || user!.login,
                email: user!.email,
                avatar_url: user!.avatar_url,
            };
        } catch (error) {
            if (
                error &&
                typeof error === 'object' &&
                'status' in error &&
                error.status === 404
            ) {
                return null;
            }
            this.logger.error({
                message: 'Error getting user by username',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getUserByEmailOrName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        email?: string;
        userName: string;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const client = this.createForgejoClient(authDetail);

            try {
                const result = await userGet({
                    client,
                    path: { username: params.userName },
                });
                const user = result.data;
                return {
                    id: user!.id!.toString(),
                    login: user!.login,
                    name: user!.full_name || user!.login,
                    email: user!.email,
                    avatar_url: user!.avatar_url,
                };
            } catch {
                // Not found by username, try search
            }

            const searchResult = await userSearch({
                client,
                query: { q: params.userName, limit: 10 },
            });
            if (searchResult.data?.data && searchResult.data.data.length > 0) {
                const user = searchResult.data.data[0];
                return {
                    id: user.id!.toString(),
                    login: user.login,
                    name: user.full_name || user.login,
                    email: user.email,
                    avatar_url: user.avatar_url,
                };
            }

            return null;
        } catch (error) {
            this.logger.error({
                message: 'Error getting user by email or name',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async getCurrentUser(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<any | null> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return null;

            const client = this.createForgejoClient(authDetail);
            const result = await userGetCurrent({ client });

            const user = result.data;
            return {
                id: user!.id!.toString(),
                login: user!.login,
                name: user!.full_name || user!.login,
                email: user!.email,
                avatar_url: user!.avatar_url,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting current user',
                context: ForgejoService.name,
                error,
            });
            return null;
        }
    }

    async deleteWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return;

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories) return;

            const client = this.createForgejoClient(authDetail);
            const webhookUrl = this.configService.get<string>(
                'FORGEJO_WEBHOOK_URL',
            );

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'deleteWebhook',
                );
                if (!repoInfo) continue;

                try {
                    const result = await repoListHooks({
                        client,
                        path: { owner: repoInfo.owner, repo: repoInfo.repo },
                    });
                    const hooks = result.data ?? [];
                    for (const hook of hooks) {
                        if (hook.config?.url === webhookUrl && hook.id) {
                            await repoDeleteHook({
                                client,
                                path: {
                                    owner: repoInfo.owner,
                                    repo: repoInfo.repo,
                                    id: hook.id,
                                },
                            });
                            this.logger.log({
                                message: `Deleted webhook for ${repo.name}`,
                                context: ForgejoService.name,
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Error deleting webhook for ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error deleting webhooks',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async createPullRequestWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return;

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            if (!repositories || repositories.length === 0) return;

            const client = this.createForgejoClient(authDetail);
            const webhookUrl = this.configService.get<string>(
                'API_FORGEJO_CODE_MANAGEMENT_WEBHOOK',
            );

            if (!webhookUrl) {
                this.logger.warn({
                    message: 'Forgejo webhook URL not configured',
                    context: ForgejoService.name,
                });
                return;
            }

            for (const repo of repositories) {
                const repoInfo = this.extractRepoInfo(
                    repo.name,
                    'createPullRequestWebhook',
                );
                if (!repoInfo) continue;

                try {
                    const existingResult = await repoListHooks({
                        client,
                        path: { owner: repoInfo.owner, repo: repoInfo.repo },
                    });
                    const existingHooks = existingResult.data ?? [];
                    const existingHook = existingHooks.find(
                        (hook) => hook.config?.url === webhookUrl,
                    );
                    const desiredEvents = [
                        'push',
                        'pull_request',
                        'issue_comment',
                        'pull_request_review',
                        'pull_request_review_comment',
                    ];

                    if (!existingHook) {
                        await repoCreateHook({
                            client,
                            path: {
                                owner: repoInfo.owner,
                                repo: repoInfo.repo,
                            },
                            body: {
                                type: 'forgejo',
                                config: {
                                    url: webhookUrl,
                                    content_type: 'json',
                                },
                                events: desiredEvents,
                                active: true,
                            },
                        });

                        this.logger.log({
                            message: `Webhook created for repository ${repo.name}`,
                            context: ForgejoService.name,
                        });
                        continue;
                    }

                    const existingEvents = new Set(existingHook.events ?? []);
                    const missingEvents = desiredEvents.filter(
                        (eventName) => !existingEvents.has(eventName),
                    );

                    if (missingEvents.length === 0) {
                        continue;
                    }

                    await repoEditHook({
                        client,
                        path: {
                            owner: repoInfo.owner,
                            repo: repoInfo.repo,
                            id: existingHook.id!,
                        },
                        body: {
                            config: {
                                url: webhookUrl,
                                content_type: 'json',
                            },
                            events: desiredEvents,
                            active: existingHook.active ?? true,
                        },
                    });

                    this.logger.log({
                        message: `Webhook updated for repository ${repo.name}`,
                        context: ForgejoService.name,
                        metadata: { missingEvents },
                    });
                } catch (error) {
                    this.logger.error({
                        message: `Error creating webhook for repository ${repo.name}`,
                        context: ForgejoService.name,
                        error,
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error creating pull request webhooks',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async isWebhookActive(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<boolean> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return false;

            const repositories =
                await this.findOneByOrganizationAndTeamDataAndConfigKey(
                    params.organizationAndTeamData,
                    IntegrationConfigKey.REPOSITORIES,
                );

            const repo = repositories?.find(
                (r: any) => r.id === params.repositoryId,
            );
            if (!repo) return false;

            const repoInfo = this.extractRepoInfo(repo.name, 'isWebhookActive');
            if (!repoInfo) return false;

            const client = this.createForgejoClient(authDetail);
            const webhookUrl = this.configService.get<string>(
                'FORGEJO_WEBHOOK_URL',
            );

            const result = await repoListHooks({
                client,
                path: { owner: repoInfo.owner, repo: repoInfo.repo },
            });
            const hooks = result.data ?? [];
            return hooks.some(
                (hook) => hook.config?.url === webhookUrl && hook.active,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error checking webhook status',
                context: ForgejoService.name,
                error,
            });
            return false;
        }
    }

    async addReactionToPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reaction: Reaction;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail || !params.repository.name) return;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'addReactionToPR',
            );
            if (!repoInfo) return;

            const client = this.createForgejoClient(authDetail);
            await issuePostIssueReaction({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
                body: { content: params.reaction },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error adding reaction to PR',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async addReactionToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reaction: Reaction;
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail || !params.repository.name) return;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'addReactionToComment',
            );
            if (!repoInfo) return;

            const client = this.createForgejoClient(authDetail);
            await issuePostCommentReaction({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    id: params.commentId,
                },
                body: { content: params.reaction },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error adding reaction to comment',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async removeReactionsFromPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reactions: Reaction[];
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail || !params.repository.name) return;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'removeReactionsFromPR',
            );
            if (!repoInfo) return;

            const client = this.createForgejoClient(authDetail);
            for (const reaction of params.reactions) {
                await issueDeleteIssueReaction({
                    client,
                    path: {
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                        index: params.prNumber,
                    },
                    body: { content: reaction },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error removing reactions from PR',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async removeReactionsFromComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reactions: Reaction[];
    }): Promise<void> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail || !params.repository.name) return;

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'removeReactionsFromComment',
            );
            if (!repoInfo) return;

            const client = this.createForgejoClient(authDetail);
            for (const reaction of params.reactions) {
                await issueDeleteCommentReaction({
                    client,
                    path: {
                        owner: repoInfo.owner,
                        repo: repoInfo.repo,
                        id: params.commentId,
                    },
                    body: { content: reaction },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error removing reactions from comment',
                context: ForgejoService.name,
                error,
            });
        }
    }

    async countReactions(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string };
        prNumber: number;
    }): Promise<any[]> {
        try {
            const authDetail = await this.getAuthDetails(
                params.organizationAndTeamData,
            );
            if (!authDetail) return [];

            const repoInfo = this.extractRepoInfo(
                params.repository.name,
                'countReactions',
            );
            if (!repoInfo) return [];

            const client = this.createForgejoClient(authDetail);
            const result = await issueGetIssueReactions({
                client,
                path: {
                    owner: repoInfo.owner,
                    repo: repoInfo.repo,
                    index: params.prNumber,
                },
            });

            const reactions = result.data ?? [];
            const counts: Record<string, number> = {};
            for (const r of reactions) {
                if (r.content) {
                    counts[r.content] = (counts[r.content] || 0) + 1;
                }
            }

            return Object.entries(counts).map(([reaction, count]) => ({
                content: reaction,
                count,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error counting reactions',
                context: ForgejoService.name,
                error,
            });
            return [];
        }
    }

    async getRepositoryContentBatch(
        _params: any,
    ): Promise<Map<string, any> | null> {
        // Not implemented for Forgejo — callers fall back to per-file
        // `getRepositoryContentFile`.
        return null;
    }

    async getUsersByUsername(_params: any): Promise<Map<string, any> | null> {
        // Not implemented for Forgejo — callers fall back to per-user
        // `getUserByUsername`.
        return null;
    }
}
