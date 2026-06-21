import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAppAuth } from '@octokit/auth-app';
import { INTEGRATION_REQUEST_TIMEOUT_MS } from '@libs/core/infrastructure/http/integration-timeouts';
import { graphql } from '@octokit/graphql';
import { enterpriseServer313 } from '@octokit/plugin-enterprise-server';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit, RestEndpointMethodTypes } from '@octokit/rest';

import * as moment from 'moment-timezone';

import pLimit from 'p-limit';
import { v4 as uuidv4 } from 'uuid';

import { createLogger } from '@kodus/flow';
import {
    GitHubReaction,
    Reaction,
} from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { fitPRDescription } from '@libs/code-review/utils/fit-pr-description';
import { getCodeReviewBadge } from '@libs/common/utils/codeManagement/codeReviewBadge';
import { getLabelShield } from '@libs/common/utils/codeManagement/labels';
import { getSeverityLevelShield } from '@libs/common/utils/codeManagement/severityLevel';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { IntegrationServiceDecorator } from '@libs/common/utils/decorators/integration-service.decorator';
import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@libs/common/utils/glob-utils';
import {
    extractRepoData,
    extractRepoName,
    extractRepoNames,
} from '@libs/common/utils/helpers';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@libs/common/utils/translations/translations';
import { CacheService } from '@libs/core/cache/cache.service';
import {
    CreateAuthIntegrationStatus,
    InstallationStatus,
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
import { GithubAuthDetail } from '@libs/integrations/domain/authIntegrations/types/github-auth-detail.type';
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
import { IGithubService } from '@libs/platform/domain/github/contracts/github.service.contract';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import {
    CodeManagementConnectionStatus,
    ICodeManagementService,
    PullRequestFileChange,
} from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import { GitCloneParams } from '@libs/platform/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
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
import {
    RepositoryFile,
    RepositoryFileWithContent,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import { IRepository } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import {
    ALLOWLIST_TREES_ONLY,
    attachETagHooksAllowlist,
    ETagCacheEntry,
    ETagStore,
} from './octokit-etag-allowlist';
import {
    buildDefaultSourceBranchName,
    DEFAULT_COMMIT_MESSAGE,
    DEFAULT_PR_TITLE,
} from '../code-management-defaults.constants';

interface GitHubAuthResponse {
    token: string;
    expiresAt: string;
    permissions?: Record<string, string>;
    repositorySelection?: string;
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

    private readonly logger = createLogger(GithubService.name);

    private readonly enterpriseOctokit = Octokit.plugin(
        enterpriseServer313,
        retry,
        throttling,
    );

    private readonly standardUserOctokit = Octokit.plugin(retry, throttling);

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly cacheService: CacheService,
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

    private normalizeGithubHost(host?: string): string | undefined {
        if (!host?.trim()) {
            return undefined;
        }

        const normalized = host.trim().replace(/\/+$/, '');
        const withProtocol = /^https?:\/\//i.test(normalized)
            ? normalized
            : `https://${normalized}`;

        return withProtocol.replace(/\/+$/, '');
    }

    private getGithubApiBaseUrl(host?: string): string | undefined {
        const normalizedHost = this.normalizeGithubHost(host);

        if (!normalizedHost) {
            return undefined;
        }

        return `${normalizedHost}/api/v3`;
    }

    private getGithubGraphqlBaseUrl(host?: string): string | undefined {
        const normalizedHost = this.normalizeGithubHost(host);

        if (!normalizedHost) {
            return undefined;
        }

        return `${normalizedHost}/api/graphql`;
    }

    private getGithubWebBaseUrl(host?: string): string {
        const normalizedHost = this.normalizeGithubHost(host);

        if (!normalizedHost) {
            return 'https://github.com';
        }

        return normalizedHost;
    }

    private createUserOctokitClient(params: {
        auth: string;
        host?: string;
        retries?: number;
        retry?: {
            doNotRetry: number[];
        };
        throttle?: {
            onRateLimit: (
                retryAfter: number,
                options: { method: string; url: string },
                octokit: Octokit,
            ) => boolean;
            onSecondaryRateLimit: (
                retryAfter: number,
                options: { method: string; url: string },
                octokit: Octokit,
            ) => boolean;
        };
    }): Octokit {
        const baseUrl = this.getGithubApiBaseUrl(params.host);
        const throttleConfig =
            params.throttle ??
            ({
                onRateLimit: () => false,
                onSecondaryRateLimit: () => false,
            } as {
                onRateLimit: (
                    retryAfter: number,
                    options: { method: string; url: string },
                    octokit: Octokit,
                ) => boolean;
                onSecondaryRateLimit: (
                    retryAfter: number,
                    options: { method: string; url: string },
                    octokit: Octokit,
                ) => boolean;
            });

        // Use the enterprise plugin only for GHES hosts to avoid changing
        // endpoint behavior for github.com PAT integrations.
        if (!baseUrl) {
            return new this.standardUserOctokit({
                auth: params.auth,
                request: { retries: params.retries ?? 0 },
                ...(params.retry && { retry: params.retry }),
                throttle: throttleConfig,
            }) as unknown as Octokit;
        }

        return new this.enterpriseOctokit({
            auth: params.auth,
            ...(baseUrl && { baseUrl }),
            request: { retries: params.retries ?? 0 },
            ...(params.retry && { retry: params.retry }),
            throttle: throttleConfig,
        }) as unknown as Octokit;
    }

    // Helper functions
    private createOctokitInstance(): Octokit {
        let privateKey = this.configService.get<string>(
            'API_GITHUB_PRIVATE_KEY',
        );

        if (privateKey) {
            // Trim whitespace first
            privateKey = privateKey.trim();

            // Remove surrounding double quotes if present (common in .env misconfiguration)
            privateKey = privateKey.replace(/^"|"$/g, '');

            // Remove escape characters that might have been added by JSON stringify/env injection
            privateKey = privateKey.replace(/\\n/g, '\n');

            // Check if key is malformed (single line or missing newlines between headers)
            // Supports both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY)
            const headerMatch = privateKey.match(
                /-----BEGIN (RSA )?PRIVATE KEY-----/,
            );
            if (headerMatch && !privateKey.includes(`${headerMatch[0]}\n`)) {
                // Aggressively clean: remove headers, spaces, newlines, trim
                const cleanBody = privateKey
                    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
                    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
                    .replace(/\s+/g, '') // Remove all whitespaces/newlines from body
                    .trim();

                const header = headerMatch[0];
                const footer = header.replace('BEGIN', 'END');

                // Reformat to proper PEM with 64 char line breaks
                const chunks = cleanBody.match(/.{1,64}/g) || [];
                privateKey = `${header}\n${chunks.join('\n')}\n${footer}`;
            }
        }

        if (!privateKey) {
            this.logger.error({
                message: 'Github Private Key is missing or invalid',
                context: GithubService.name,
            });
        }

        return new Octokit({
            request: {
                timeout: 60000,
            },
            authStrategy: createAppAuth,
            auth: {
                appId: this.configService.get<string>('API_GITHUB_APP_ID'),
                privateKey: privateKey,
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

            const githubAuthDetail = await this.getGithubAuthDetails(
                params.organizationAndTeamData,
            );

            const shouldRefreshTokenWebhooks =
                githubAuthDetail?.authMode === AuthMode.TOKEN &&
                params.configKey === IntegrationConfigKey.REPOSITORIES;

            const previousRepositories = shouldRefreshTokenWebhooks
                ? ((await this.findOneByOrganizationAndTeamDataAndConfigKey(
                      params.organizationAndTeamData,
                      IntegrationConfigKey.REPOSITORIES,
                  )) ?? [])
                : [];

            const updatedConfig =
                await this.integrationConfigService.createOrUpdateConfig(
                    params.configKey,
                    params.configValue,
                    integration?.uuid,
                    params.organizationAndTeamData,
                    params.type,
                );

            if (shouldRefreshTokenWebhooks) {
                const nextRepositories = <Repositories[]>(
                    (updatedConfig?.configValue ?? params.configValue ?? [])
                );
                const removedRepositories = previousRepositories.filter(
                    (previousRepository) =>
                        !nextRepositories.some(
                            (nextRepository) =>
                                nextRepository.id?.toString() ===
                                    previousRepository.id?.toString() ||
                                nextRepository.name === previousRepository.name,
                        ),
                );

                if (removedRepositories.length > 0) {
                    await this.deleteWebhook({
                        organizationAndTeamData: params.organizationAndTeamData,
                        repositories: removedRepositories,
                    });
                }

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
                // @ts-expect-error property not found in type
                authToken: installationAuthentication?.token,
                installationId:
                    // @ts-expect-error property not found in type
                    installationAuthentication?.installationId || null,
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
            const normalizedHost = this.normalizeGithubHost(params.host);
            const userOctokit = this.createUserOctokitClient({
                auth: token,
                host: normalizedHost,
            });

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
                host: normalizedHost,
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
                err.message || 'Error authenticating with GITHUB PAT.',
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

    async findRepositoryByName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        name: string;
    }): Promise<Partial<Repository> | null> {
        const repositories = await this.getRepositories({
            organizationAndTeamData: params.organizationAndTeamData,
        });

        const wanted = params.name.trim().toLowerCase();
        const foundRepo = repositories.find((repo) => {
            const fullName = (
                repo.full_name || `${repo.organizationName}/${repo.name}`
            ).toLowerCase();

            return repo.name.toLowerCase() === wanted || fullName === wanted;
        });

        if (!foundRepo) {
            return null;
        }

        return {
            id: foundRepo.id,
            name: foundRepo.name,
            fullName:
                foundRepo.full_name ||
                `${foundRepo.organizationName}/${foundRepo.name}`,
            defaultBranch: foundRepo.default_branch,
        };
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

        const pullRequestTitle = title?.trim() || DEFAULT_PR_TITLE;
        const resolvedBaseBranch =
            baseBranch ||
            targetBranch ||
            (await this.getDefaultBranch({
                organizationAndTeamData,
                repository,
            }));
        const resolvedSourceBranch =
            sourceBranch || buildDefaultSourceBranchName();
        const resolvedTargetBranch = targetBranch || resolvedBaseBranch;
        const resolvedCommitMessage =
            commitMessage?.trim() || DEFAULT_COMMIT_MESSAGE;

        try {
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
                this.logger.error({
                    message: 'Failed to upload files for pull request creation',
                    context: GithubService.name,
                    metadata: {
                        repository: repository.name,
                        sourceBranch: resolvedSourceBranch,
                        targetBranch: resolvedTargetBranch,
                        baseBranch: resolvedBaseBranch,
                        title: pullRequestTitle,
                        files: files.map((f) => f.path),
                    },
                });
                return null;
            }

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(
                organizationAndTeamData,
                githubAuthDetail,
            );

            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            const prResponse = await octokit.rest.pulls.create({
                owner,
                repo: repository.name,
                title: pullRequestTitle,
                head: resolvedSourceBranch,
                base: resolvedTargetBranch,
                body: description,
            });

            if (prResponse.status === 201) {
                const prData = prResponse.data;

                return {
                    id: prData.id.toString(),
                    number: prData.number,
                    title: prData.title,
                    prURL: prData.html_url,
                };
            } else {
                this.logger.error({
                    message: 'Failed to create pull request',
                    context: GithubService.name,
                    metadata: {
                        repository: repository.name,
                        sourceBranch: resolvedSourceBranch,
                        targetBranch: resolvedTargetBranch,
                        baseBranch: resolvedBaseBranch,
                        title: pullRequestTitle,
                        files: files.map((f) => f.path),
                        status: prResponse.status,
                    },
                });

                return null;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error creating pull request with files',
                context: GithubService.name,
                error,
                metadata: {
                    repository: repository.name,
                    sourceBranch: resolvedSourceBranch,
                    targetBranch: resolvedTargetBranch,
                    baseBranch: resolvedBaseBranch,
                    title: pullRequestTitle,
                    files: files.map((f) => f.path),
                },
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

        const resolvedBaseBranch =
            baseBranch ||
            (await this.getDefaultBranch({
                organizationAndTeamData,
                repository,
            }));
        const resolvedBranchName = branchName || resolvedBaseBranch;
        const resolvedMessage = message?.trim() || DEFAULT_COMMIT_MESSAGE;

        try {
            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const tokenAuthorIdentity =
                githubAuthDetail?.authMode === AuthMode.TOKEN && author?.name
                    ? {
                          name: author.name,
                          email: author.email || 'kody@kodus.io',
                      }
                    : undefined;

            const octokit = await this.instanceOctokit(
                organizationAndTeamData,
                githubAuthDetail,
            );

            const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

            const { data: baseRef } = await octokit.rest.git.getRef({
                owner,
                repo: repository.name,
                ref: `heads/${resolvedBaseBranch}`,
            });
            const baseSha = baseRef.object.sha;

            let parentSha = baseSha;
            let branchAlreadyExists = resolvedBranchName === resolvedBaseBranch;

            if (resolvedBranchName !== resolvedBaseBranch) {
                try {
                    const { data: sourceBranchRef } =
                        await octokit.rest.git.getRef({
                            owner,
                            repo: repository.name,
                            ref: `heads/${resolvedBranchName}`,
                        });

                    parentSha = sourceBranchRef.object.sha;
                    branchAlreadyExists = true;
                } catch (error) {
                    if ((error as { status?: number })?.status !== 404) {
                        throw error;
                    }
                }
            }

            const treeItems = await Promise.all(
                files.map(async (file) => {
                    const operation = file.operation || 'upsert';

                    if (operation === 'delete') {
                        return {
                            path: file.path,
                            mode: '100644' as const,
                            type: 'blob' as const,
                            sha: null,
                        };
                    }

                    if (typeof file.content !== 'string') {
                        throw new Error(
                            `File content is required for upsert operation: ${file.path}`,
                        );
                    }

                    const { data: blob } = await octokit.rest.git.createBlob({
                        owner,
                        repo: repository.name,
                        content: Buffer.from(file.content).toString('base64'),
                        encoding: 'base64',
                    });

                    return {
                        path: file.path,
                        mode: '100644' as const,
                        type: 'blob' as const,
                        sha: blob.sha,
                    };
                }),
            );

            // GitHub's createTree fails atomically with GitRPC::BadObjectState
            // when any delete op targets a path that doesn't exist in
            // base_tree. Filter and retry once before giving up — this covers
            // DB/repo drift (e.g., a directory group with kody-rules but no
            // kodus-config.yml override never produced a config file on disk).
            let effectiveTreeItems = treeItems;
            let createdTreeSha: string;
            try {
                const { data: tree } = await octokit.rest.git.createTree({
                    owner,
                    repo: repository.name,
                    tree: effectiveTreeItems,
                    base_tree: parentSha,
                });
                createdTreeSha = tree.sha;
            } catch (treeError) {
                if (!this.isBadObjectStateError(treeError)) {
                    throw treeError;
                }

                const existingPaths = await this.fetchTreeBlobPaths(
                    octokit,
                    owner,
                    repository.name,
                    parentSha,
                );

                if (existingPaths === null) {
                    // Couldn't reliably enumerate the tree — don't risk a
                    // false-positive filter. Rethrow original error.
                    throw treeError;
                }

                const filtered = effectiveTreeItems.filter((item) => {
                    if (item.sha === null) {
                        return existingPaths.has(item.path);
                    }
                    return true;
                });

                if (filtered.length === effectiveTreeItems.length) {
                    // Nothing to drop — error came from something else.
                    throw treeError;
                }

                const droppedPaths = effectiveTreeItems
                    .filter(
                        (item) =>
                            item.sha === null &&
                            !existingPaths.has(item.path),
                    )
                    .map((item) => item.path);

                if (filtered.length === 0) {
                    // Updating an existing tracked PR is fine — the branch
                    // already has whatever it had before. For a fresh branch
                    // there's nothing to commit and no branch to attach a PR
                    // to, so signal failure to the caller.
                    if (branchAlreadyExists) {
                        this.logger.warn({
                            message:
                                'All requested file operations were no-ops on an existing branch; skipping commit',
                            context: GithubService.name,
                            metadata: {
                                repository: repository.name,
                                branchName: resolvedBranchName,
                                droppedPaths,
                            },
                        });
                        return true;
                    }
                    this.logger.warn({
                        message:
                            'All requested deletes targeted non-existent paths and no upserts remain; nothing to commit on a new branch',
                        context: GithubService.name,
                        metadata: {
                            repository: repository.name,
                            branchName: resolvedBranchName,
                            droppedPaths,
                        },
                    });
                    return false;
                }

                this.logger.warn({
                    message:
                        'Retrying tree creation after dropping deletes for non-existent paths',
                    context: GithubService.name,
                    metadata: {
                        repository: repository.name,
                        branchName: resolvedBranchName,
                        droppedPaths,
                    },
                });

                effectiveTreeItems = filtered;
                const { data: retryTree } =
                    await octokit.rest.git.createTree({
                        owner,
                        repo: repository.name,
                        tree: effectiveTreeItems,
                        base_tree: parentSha,
                    });
                createdTreeSha = retryTree.sha;
            }

            const { data: commit } = await octokit.rest.git.createCommit({
                owner,
                repo: repository.name,
                message: resolvedMessage,
                tree: createdTreeSha,
                parents: [parentSha],
                ...(tokenAuthorIdentity
                    ? {
                          author: tokenAuthorIdentity,
                          committer: tokenAuthorIdentity,
                      }
                    : {}),
            });

            if (branchAlreadyExists) {
                await octokit.rest.git.updateRef({
                    owner,
                    repo: repository.name,
                    ref: `heads/${resolvedBranchName}`,
                    sha: commit.sha,
                });
            } else {
                await octokit.rest.git.createRef({
                    owner,
                    repo: repository.name,
                    ref: `refs/heads/${resolvedBranchName}`,
                    sha: commit.sha,
                });
            }

            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error uploading files to GitHub',
                context: GithubService.name,
                error,
                metadata: {
                    repository: repository.name,
                    branchName: resolvedBranchName,
                    baseBranch: resolvedBaseBranch,
                    files: files.map((f) => f.path),
                },
            });

            return false;
        }
    }

    private isBadObjectStateError(error: unknown): boolean {
        if (!error) {
            return false;
        }
        const message =
            (error as { message?: unknown })?.message ?? String(error);
        return typeof message === 'string'
            ? message.toLowerCase().includes('badobjectstate')
            : false;
    }

    private async fetchTreeBlobPaths(
        octokit: any,
        owner: string,
        repo: string,
        commitOrTreeSha: string,
    ): Promise<Set<string> | null> {
        try {
            // The commit SHA resolves to its tree via `getTree` — GitHub's API
            // accepts either a commit SHA or a tree SHA on this endpoint.
            const { data } = await octokit.rest.git.getTree({
                owner,
                repo,
                tree_sha: commitOrTreeSha,
                recursive: 'true',
            });

            // Truncated responses can't be trusted for filtering — a missing
            // path could still be present in a chunk we didn't see.
            if (data.truncated) {
                return null;
            }

            const paths = new Set<string>();
            for (const node of data.tree ?? []) {
                if (node.type === 'blob' && typeof node.path === 'string') {
                    paths.add(node.path);
                }
            }
            return paths;
        } catch {
            return null;
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

    private async getSuspendedStatusBatch(
        octokit: Octokit,
        logins: string[],
        batchSize: number = 100,
    ): Promise<Map<string, boolean>> {
        if (logins.length === 0) return new Map();

        const statusMap = new Map<string, boolean>();
        let aliasCounter = 0;

        for (let i = 0; i < logins.length; i += batchSize) {
            const batch = logins.slice(i, i + batchSize);

            const aliasFields = batch.map((login) => {
                const alias = `u${aliasCounter++}`;
                const safeLogin = login.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                return `${alias}: user(login: "${safeLogin}") { suspendedAt }`;
            });

            const query = `query { ${aliasFields.join('\n')} }`;

            try {
                const response = await octokit.graphql(query) as Record<string, { suspendedAt: string | null } | null>;

                batch.forEach((login, idx) => {
                    const alias = `u${aliasCounter - batch.length + idx}`;
                    const userData = response[alias];
                    statusMap.set(login, userData?.suspendedAt === null);
                });
            } catch (error) {
                this.logger.error({
                    message: 'GraphQL batch query failed for suspended status',
                    context: GithubService.name,
                    error,
                    metadata: { batch: batch.join(', ') },
                });

                batch.forEach((login) => statusMap.set(login, true));
            }
        }

        return statusMap;
    }

    async getListMembers(
        params: any,
    ): Promise<{ name: string; id: string | number; type?: string }[]> {
        const members = await this.getAllMembersByOrg(
            params.organizationAndTeamData,
        );

        if (!members || members.length === 0) return [];

        const octokit = await this.instanceOctokit(params.organizationAndTeamData);
        const logins = members.map((user) => user.login);
        const activeMap = await this.getSuspendedStatusBatch(octokit, logins);

        return members
            .filter((user) => activeMap.get(user.login) ?? true)
            .map((user) => ({
                name: user.login,
                id: user.id,
                type: user?.type === 'Bot' ? 'bot' : 'user',
            }));
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
                    } catch {
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
                (pathParts[2] === 'pull' || pathParts[2] === 'pulls')
            ) {
                const owner = pathParts[0];
                const repo = pathParts[1];
                const prNumber = parseInt(pathParts[3], 10);

                if (!isNaN(prNumber)) {
                    return { owner, repo, prNumber };
                }
            }
        } catch {
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
        const appOctokit = this.createOctokitInstance();

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
                request: { timeout: INTEGRATION_REQUEST_TIMEOUT_MS },
            });

            await octokit.rest.rateLimit.get();
            return true;
        } catch {
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

    public async getAuthenticatedOctokit(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<Octokit> {
        return this.instanceOctokit(organizationAndTeamData);
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
                    auth: installationAuthentication.token,
                    request: { retries: 2 },
                    retry: {
                        doNotRetry: [400, 401, 403, 404, 422, 451],
                    },
                    throttle: {
                        onRateLimit: (
                            retryAfter,
                            options,
                            octokit,
                            retryCount,
                        ) => {
                            const attempts = retryCount;
                            const jitter = Math.floor(Math.random() * 1000);

                            const headers =
                                (options.request as any)?.response?.headers ??
                                {};
                            const rateLimit = headers['x-ratelimit-limit'];
                            const rateRemaining =
                                headers['x-ratelimit-remaining'];
                            const rateReset = headers['x-ratelimit-reset'];
                            const rateResource =
                                headers['x-ratelimit-resource'];

                            // Log do Octokit (mantém compatibilidade com plugin)
                            octokit.log.warn(
                                `RATE-LIMIT ${rateResource ?? 'core'}: ${options.method} ${options.url} — retryAfter=${retryAfter}s attempts=${attempts} limit=${rateLimit ?? '?'} remaining=${rateRemaining ?? '?'}`,
                            );

                            // Log do Pino (integração com sistema de logging)
                            this.logger.warn({
                                // Retries within octokit are intentionally
                                // disabled below: each retry would dorme
                                // for `retryAfter` (up to ~59 min on an
                                // exhausted installation bucket) while
                                // holding the worker slot. We instead let
                                // the request throw immediately and have
                                // the consumer error handler republish the
                                // job with a delay aligned to the bucket
                                // reset — that's what RateLimitError +
                                // RabbitMQErrorHandler do.
                                message: `RATE-LIMIT ${rateResource ?? 'core'}: ${options.method} ${options.url} — retryAfter=${retryAfter}s attempts=${attempts} limit=${rateLimit ?? '?'} remaining=${rateRemaining ?? '?'}`,
                                context: GithubService.name,
                                metadata: {
                                    method: options.method,
                                    url: options.url,
                                    retryAfter,
                                    attempts,
                                    rateLimit:
                                        rateLimit !== undefined
                                            ? Number(rateLimit)
                                            : undefined,
                                    rateRemaining:
                                        rateRemaining !== undefined
                                            ? Number(rateRemaining)
                                            : undefined,
                                    rateReset:
                                        rateReset !== undefined
                                            ? Number(rateReset)
                                            : undefined,
                                    rateResource,
                                    organizationId:
                                        organizationAndTeamData.organizationId,
                                    teamId: organizationAndTeamData.teamId,
                                },
                            });

                            // Zero in-octokit retries. Returning false
                            // here makes the throttling plugin re-throw
                            // the original 403 immediately, which the
                            // calling processor catches and converts to
                            // `RateLimitError(resetAt)`. The RabbitMQ
                            // error handler then republishes the job
                            // with a delay aligned to the bucket reset.
                            // The previous behavior (up to 2 retries
                            // dorme by `retryAfter` each = up to ~3h
                            // pinned inside a single octokit call) is
                            // strictly worse: the same wait happens, but
                            // the worker slot is held the entire time.
                            void jitter; // kept for log shape parity
                            return false;
                        },
                        onSecondaryRateLimit: (
                            retryAfter,
                            options,
                            octokit,
                            retryCount,
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

                const octokit = this.createUserOctokitClient({
                    auth: decryptedPAT,
                    host: githubAuthDetail.host,
                    retries: 2,
                    retry: {
                        doNotRetry: [400, 401, 403, 404, 422, 451],
                    },
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
                const graphQlBaseUrl = this.getGithubGraphqlBaseUrl(
                    githubAuthDetail.host,
                );

                const graphqlClient = graphql.defaults({
                    ...(graphQlBaseUrl && { baseUrl: graphQlBaseUrl }),
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
                request: { timeout: INTEGRATION_REQUEST_TIMEOUT_MS },
            });

            const installationAuthentication = await appOctokit.auth({
                type: 'installation',
                installationId: code,
            });

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
                // @ts-expect-error property not found in type
                authToken: installationAuthentication?.token,
                installationId:
                    // @ts-expect-error property not found in type
                    installationAuthentication?.installationId || null,
                org: installationData.account.login || null,
            };

            if (!integration) {
                await this.addAccessToken(organizationAndTeamData, authDetails);
            } else {
                await this.updateAuthIntegration({
                    organizationAndTeamData,
                    // @ts-expect-error property not found in type
                    accessToken: installationAuthentication?.token,
                    authIntegrationId: integration?.authIntegration?.uuid,
                    integrationId: integration?.uuid,
                    installationId:
                        // @ts-expect-error property not found in type
                        installationAuthentication?.installationId,
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

            // @ts-expect-error property not found in type
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

        // 1. Get the SHA of the last analyzed commit
        const baseSha = lastCommit?.sha;

        // 2. Get all commits in the PR and find the most recent one (head)
        const commits = await octokit.paginate(octokit.pulls.listCommits, {
            owner: githubAuthDetail?.org,
            repo: repository?.name,
            pull_number: prNumber,
        });

        const sortedCommits = [...commits].sort(
            (a, b) =>
                new Date(a?.commit?.author?.date).getTime() -
                new Date(b?.commit?.author?.date).getTime(),
        );

        const headSha = sortedCommits[sortedCommits?.length - 1]?.sha;

        if (!headSha || !baseSha || baseSha === headSha) {
            return [];
        }

        // 3. Compare the two commits to get only the new changes
        // This returns the diff between the last reviewed commit and the latest commit
        const { data: comparison } =
            await octokit.repos.compareCommitsWithBasehead({
                owner: githubAuthDetail?.org,
                repo: repository.name,
                basehead: `${baseSha}...${headSha}`,
            });

        const compareFiles = comparison.files || [];

        // 4. Get the PR files list to filter out files that came from merge commits
        // pulls.listFiles only returns files that belong to the PR (relative to base branch)
        const prFiles = await octokit.paginate(octokit.pulls.listFiles, {
            owner: githubAuthDetail?.org,
            repo: repository.name,
            pull_number: prNumber,
        });

        const prFileNames = new Set(prFiles.map((f) => f.filename));

        // 5. Keep only files that exist in both compare AND PR file list
        return compareFiles
            .filter((file) => prFileNames.has(file.filename))
            .map((file) => ({
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch,
            }));
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
        const { organizationAndTeamData, repository, prNumber, headSha } =
            params;

        // Cache: the list of changed files for a PR at a specific HEAD
        // SHA is immutable — pushing a new commit produces a new SHA.
        // The pipeline calls this twice per job (PullRequestManagerService
        // `getChangedFiles` + `getChangedFilesMetadata`), and a paginated
        // PR can fan out into 5-15+ subrequests. Caching by (prNumber,
        // headSha) cuts the second call to a memory lookup.
        //
        // Callers that don't pass `headSha` (legacy paths, cron jobs that
        // don't have the head SHA handy) skip the cache and pay the
        // original cost — same behavior as before.
        const cacheKey = headSha
            ? `gh:pr-files:${organizationAndTeamData?.organizationId ?? 'no-org'}:${repository?.id ?? repository?.name}:${prNumber}:${headSha}`
            : null;
        if (cacheKey) {
            const cached = await this.cacheService.getFromCache<any[]>(
                cacheKey,
            );
            if (cached) return cached;
        }

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);
        const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
            owner: githubAuthDetail?.org,
            repo: repository?.name,
            pull_number: prNumber,
        });

        const result = files.map((file) => ({
            filename: file.filename,
            sha: file?.sha ?? null,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
        }));

        if (cacheKey && result.length > 0) {
            await this.cacheService.addToCache(
                cacheKey,
                result,
                10 * 60 * 1000, // 10min — short enough that a stale read after
                // a fast force-push is unlikely, but long enough that the two
                // calls in the same pipeline always hit.
            );
        }
        return result;
    }

    formatCodeBlock(language: string, code: string) {
        return `\`\`\`${language}\n${code}\n\`\`\``;
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
        isCommittableSuggestion?: boolean,
    ) {
        const improvedCode = isCommittableSuggestion
            ? lineComment?.suggestion?.validatedData?.code
            : lineComment?.body?.improvedCode;

        const language = isCommittableSuggestion
            ? 'suggestion'
            : lineComment?.suggestion?.language?.toLowerCase() ||
              repository?.language?.toLowerCase();

        const severityShield = lineComment?.suggestion
            ? getSeverityLevelShield(lineComment.suggestion.severity)
            : '';

        const codeBlock = improvedCode
            ? this.formatCodeBlock(
                  language,
                  isCommittableSuggestion
                      ? improvedCode
                      : this.dedentCode(improvedCode),
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

        const experimentalWarning = isCommittableSuggestion
            ? `
<details>
<summary>Warning</summary>

This is an experimental feature that generates committable changes. Review the diff before applying. Results may be incorrect.
</details>
`
            : '';

        return [
            badges,
            suggestionContent,
            actionStatement,
            codeBlock,
            experimentalWarning,
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

        const { isCommittable, validatedData } = lineComment?.suggestion || {};

        const isCommittableSuggestion =
            isCommittable &&
            validatedData &&
            validatedData.code &&
            validatedData.lineStart !== undefined &&
            validatedData.lineEnd !== undefined;

        const startLine = isCommittableSuggestion
            ? validatedData.lineStart
            : lineComment.start_line;
        const endLine = isCommittableSuggestion
            ? validatedData.lineEnd
            : lineComment.line;

        const bodyFormatted = this.formatBodyForGitHub(
            lineComment,
            repository,
            translations,
            suggestionCopyPrompt,
            isCommittableSuggestion,
        );

        try {
            const comment = await octokit.pulls.createReviewComment({
                owner: githubAuthDetail?.org,
                repo: repository.name,
                pull_number: prNumber,
                body: bodyFormatted,
                commit_id: commit?.sha,
                path: lineComment.path,
                start_line: this.sanitizeLine(startLine),
                line: this.sanitizeLine(endLine),
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
        reaction: Reaction;
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
        reaction: Reaction;
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
        reactions: Reaction[];
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
        reactions: Reaction[];
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
            body: fitPRDescription(summary, PlatformType.GITHUB),
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

            // Cache by BLOB sha (not branch+path) so the entry invalidates
            // automatically when the file content changes — pushing a new
            // commit that modifies app.ts produces a new blob sha and a
            // fresh cache miss, instead of serving stale content for the
            // 5-min TTL window. Files unchanged across commits share the
            // cache entry (PR with 200 files where 5 changed = 195 hits
            // on the second pass).
            //
            // Defensive: skip cache entirely when sha is missing/empty —
            // better a fresh fetch than a wrong-cached value.
            const cacheKey = file?.sha
                ? `gh:contents:${githubAuthDetail?.org}/${repository.name}:${file.sha}:${file.filename}`
                : undefined;
            if (cacheKey) {
                const cached = await this.cacheService.getFromCache<any>(
                    cacheKey,
                );
                if (cached) return cached;
            }

            try {
                // First, try to fetch from the head branch of the PR
                const lines = (await octokit.repos.getContent({
                    owner: githubAuthDetail?.org,
                    repo: repository.name,
                    path: file.filename,
                    ref: pullRequest.head.ref,
                })) as any;

                if (cacheKey && lines) {
                    // 24h TTL. The cache key includes the blob sha, and
                    // a blob's content is immutable in Git by design —
                    // the same sha always resolves to the same bytes
                    // forever — so there is no stale-cache risk. Long
                    // TTL maximizes cross-PR hits when reviews touch
                    // overlapping unchanged files (cross-file context,
                    // documentation manifests, retried/duplicated
                    // webhooks, manual reruns).
                    await this.cacheService.addToCache(
                        cacheKey,
                        lines,
                        24 * 60 * 60 * 1000,
                    );
                }
                return lines;
            } catch (error) {
                const status =
                    (error as any)?.status ?? (error as any)?.response?.status;
                const refDeleted =
                    status === 404 &&
                    /No commit found for the ref/i.test(
                        (error as any)?.message ?? '',
                    );
                this.logger.warn({
                    message: refDeleted
                        ? 'PR head ref missing — falling back to base ref'
                        : 'Error getting file content from pull request',
                    context: GithubService.name,
                    error,
                    metadata: {
                        ...params,
                        prHeadMissing: refDeleted,
                        httpStatus: status,
                    },
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

    // Fetch many file contents in a single GraphQL request, keyed by blob
    // SHA. Each PR file from `pulls.listFiles` already carries its blob
    // sha, so we can resolve N files in 1 GraphQL point instead of N REST
    // points (~5000/h on the installation bucket). Cache key shape is
    // identical to `getRepositoryContentFile`, so warm entries from
    // either path are reused.
    //
    // Falls back to per-file REST for: missing/invalid sha, binary
    // blobs, blobs over ~1 MB (GraphQL returns text=null in both cases),
    // and any GraphQL-side error (whole-batch fallback).
    public async getRepositoryContentBatch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: any };
        files: Array<{ filename: string; sha?: string; [key: string]: any }>;
        pullRequest?: any;
    }): Promise<Map<string, any>> {
        const { organizationAndTeamData, repository, files, pullRequest } =
            params;
        const result = new Map<string, any>();

        if (!files?.length) return result;

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );
        if (!githubAuthDetail) return result;

        const makeCacheKey = (file: { filename: string; sha?: string }) =>
            file?.sha
                ? `gh:contents:${githubAuthDetail?.org}/${repository.name}:${file.sha}:${file.filename}`
                : undefined;

        // 1. Cache lookup — collect hits, queue misses
        const misses: Array<{ file: any; cacheKey?: string }> = [];
        for (const file of files) {
            const cacheKey = makeCacheKey(file);
            if (cacheKey) {
                const cached =
                    await this.cacheService.getFromCache<any>(cacheKey);
                if (cached) {
                    result.set(file.filename, cached);
                    continue;
                }
            }
            misses.push({ file, cacheKey });
        }

        if (misses.length === 0) return result;

        // 2. Split: batchable (valid 40-hex blob sha) vs REST-only
        const SHA_RE = /^[a-f0-9]{40}$/i;
        const batchable: Array<{ file: any; cacheKey?: string }> = [];
        const restOnly: Array<{ file: any; cacheKey?: string }> = [];
        for (const m of misses) {
            if (SHA_RE.test(m.file?.sha || '')) batchable.push(m);
            else restOnly.push(m);
        }

        // 3. GraphQL batch fetch (size 50 — conservative; GitHub accepts
        //    up to ~100 aliases but 50 keeps payloads small and limits
        //    blast radius on transient errors)
        if (batchable.length > 0) {
            const graphqlClient =
                await this.instanceGraphQL(organizationAndTeamData);
            const BATCH_SIZE = 50;

            for (let i = 0; i < batchable.length; i += BATCH_SIZE) {
                const batch = batchable.slice(i, i + BATCH_SIZE);
                const varDefs = ['$owner: String!', '$repo: String!'];
                const fields: string[] = [];
                const variables: Record<string, any> = {
                    owner: githubAuthDetail.org,
                    repo: repository.name,
                };

                batch.forEach(({ file }, idx) => {
                    varDefs.push(`$sha${idx}: GitObjectID!`);
                    fields.push(
                        `f${idx}: object(oid: $sha${idx}) { ... on Blob { text isBinary byteSize } }`,
                    );
                    variables[`sha${idx}`] = file.sha;
                });

                const query = `
                    query(${varDefs.join(', ')}) {
                        repository(owner: $owner, name: $repo) {
                            ${fields.join('\n                            ')}
                        }
                        rateLimit {
                            cost
                            remaining
                            limit
                            resetAt
                        }
                    }
                `;

                try {
                    const response: any = await graphqlClient(
                        query,
                        variables,
                    );
                    const repoNode = response?.repository;

                    // Temporary instrumentation: log the actual GraphQL
                    // cost reported by GitHub for this batch. Distinct
                    // tag for easy `docker logs ... | grep` lookup.
                    // Remove once we've validated the cost model.
                    const rl = response?.rateLimit;
                    if (rl) {
                        this.logger.log({
                            message: `[GRAPHQL_BATCH_COST] files=${batch.length} cost=${rl.cost} remaining=${rl.remaining} limit=${rl.limit} resetAt=${rl.resetAt}`,
                            context: GithubService.name,
                            metadata: {
                                instrumentation:
                                    'graphql_batch_content_cost',
                                batchSize: batch.length,
                                cost: rl.cost,
                                remaining: rl.remaining,
                                limit: rl.limit,
                                resetAt: rl.resetAt,
                                organizationAndTeamData,
                                repositoryName: repository?.name,
                            },
                        });
                    }

                    for (let j = 0; j < batch.length; j++) {
                        const { file, cacheKey } = batch[j];
                        const blob = repoNode?.[`f${j}`];

                        if (
                            blob &&
                            blob.isBinary === false &&
                            typeof blob.text === 'string'
                        ) {
                            // Shape mirrors octokit's `repos.getContent`
                            // response so `enrichFilesWithContent` reads
                            // it transparently. Encoding `utf-8` skips
                            // the base64 decode path on the caller.
                            const fileContent = {
                                data: {
                                    content: blob.text,
                                    encoding: 'utf-8',
                                },
                            };
                            result.set(file.filename, fileContent);
                            if (cacheKey) {
                                // 24h TTL — see `getRepositoryContentFile`
                                // for the immutability argument. Same
                                // cache key shape, same safety guarantees.
                                await this.cacheService.addToCache(
                                    cacheKey,
                                    fileContent,
                                    24 * 60 * 60 * 1000,
                                );
                            }
                        } else {
                            // Binary, oversize, or missing — fall back
                            // to REST single-file (which handles both
                            // base64 binary returns and the head→base
                            // ref fallback). Skip silently if we don't
                            // have the PR refs available.
                            if (pullRequest) {
                                try {
                                    const fallback =
                                        await this.getRepositoryContentFile({
                                            organizationAndTeamData,
                                            repository,
                                            file,
                                            pullRequest,
                                        });
                                    if (fallback)
                                        result.set(file.filename, fallback);
                                } catch {
                                    /* keep result without this file */
                                }
                            }
                        }
                    }
                } catch (err) {
                    this.logger.warn({
                        message:
                            'GraphQL batch content fetch failed — falling back to REST per-file for the batch',
                        context: GithubService.name,
                        error: err,
                        metadata: {
                            organizationAndTeamData,
                            repositoryName: repository?.name,
                            batchSize: batch.length,
                        },
                    });
                    if (pullRequest) {
                        // Concurrent fallback with pLimit — sequential
                        // would 50× a single GraphQL hiccup into a
                        // 15s+ stall on the FetchChangedFiles stage.
                        // Same concurrency cap as the original
                        // pullRequestManager `enrichFilesWithContent`.
                        // allSettled lets individual file failures
                        // reject without aborting the rest of the batch.
                        const limit = pLimit(30);
                        await Promise.allSettled(
                            batch.map(({ file }) =>
                                limit(async () => {
                                    const fallback =
                                        await this.getRepositoryContentFile(
                                            {
                                                organizationAndTeamData,
                                                repository,
                                                file,
                                                pullRequest,
                                            },
                                        );
                                    if (fallback)
                                        result.set(file.filename, fallback);
                                }),
                            ),
                        );
                    }
                }
            }
        }

        // 4. Files without usable blob sha — REST fallback only.
        //    Concurrent with pLimit, same rationale as the in-batch
        //    catch above: avoid serializing N round-trips when GraphQL
        //    isn't usable for these entries. allSettled keeps a
        //    single-file failure from aborting the rest.
        if (pullRequest && restOnly.length > 0) {
            const limit = pLimit(30);
            await Promise.allSettled(
                restOnly.map(({ file }) =>
                    limit(async () => {
                        const fallback = await this.getRepositoryContentFile({
                            organizationAndTeamData,
                            repository,
                            file,
                            pullRequest,
                        });
                        if (fallback) result.set(file.filename, fallback);
                    }),
                ),
            );
        }

        return result;
    }

    async getCommitsForPullRequestForCodeReview(
        params: any,
    ): Promise<any[] | null> {
        const { organizationAndTeamData, repository, prNumber, headSha } =
            params;

        // Cache: the commit list of a PR at a given HEAD SHA is immutable.
        // Two callers in the same job hit this — PullRequestManagerService
        // `getNewCommitsSinceLastExecution` and CommentManagerService
        // (during comment threading) — so caching by (prNumber, headSha)
        // halves the calls for the common path. Callers without a SHA
        // (legacy/cron) skip the cache, same behavior as before.
        const cacheKey = headSha
            ? `gh:pr-commits:${organizationAndTeamData?.organizationId ?? 'no-org'}:${repository?.id ?? repository?.name}:${prNumber}:${headSha}`
            : null;
        if (cacheKey) {
            const cached = await this.cacheService.getFromCache<any[]>(
                cacheKey,
            );
            if (cached) return cached;
        }

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

        const result = commits
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

        if (cacheKey && result && result.length > 0) {
            await this.cacheService.addToCache(
                cacheKey,
                result,
                10 * 60 * 1000, // 10min, same rationale as getFilesByPullRequestId.
            );
        }
        return result;
    }

    async createIssueComment(params: any): Promise<any | null> {
        try {
            const { organizationAndTeamData, repository, prNumber, body } =
                params;

            const githubAuthDetail = await this.getGithubAuthDetails(
                organizationAndTeamData,
            );

            const octokit = await this.instanceOctokit(organizationAndTeamData);

            // Defensive: extract repo name in case fullName (owner/name) is passed
            const repoName = extractRepoName(repository.name);

            const response = await octokit.issues.createComment({
                owner: githubAuthDetail?.org,
                repo: repoName,
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

            // Defensive: extract repo name in case fullName (owner/name) is passed
            const repoName = extractRepoName(repository?.name);

            await octokit.issues.updateComment({
                owner,
                repo: repoName,
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

        // Cache: default branch changes very rarely (renaming main/master
        // is a manual operation done once per repo lifecycle). Each ECS
        // worker keeps the result for 1h; this kills the ~500+ rate-limit
        // hits/48h we observed on `GET /repos/{owner}/{repo}` while a
        // single worker serves many PRs from the same repo. Memory store,
        // so caches are independent per container — that's fine here, the
        // worst case is each container does one fetch per repo per hour.
        const cacheKey = `gh:default-branch:${organizationAndTeamData?.organizationId ?? 'no-org'}:${repository?.id ?? repository?.name ?? 'no-repo'}`;
        const cached = await this.cacheService.getFromCache<string>(cacheKey);
        if (cached) {
            return cached;
        }

        const githubAuthDetail = await this.getGithubAuthDetails(
            organizationAndTeamData,
        );

        const octokit = await this.instanceOctokit(organizationAndTeamData);

        const response = await octokit.repos.get({
            owner: githubAuthDetail?.org,
            repo: repository?.name,
        });

        const defaultBranch = response?.data?.default_branch;
        if (defaultBranch) {
            await this.cacheService.addToCache(
                cacheKey,
                defaultBranch,
                60 * 60 * 1000, // 1h
            );
        }
        return defaultBranch;
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

        const webhookUrl = this.getGithubWebhookUrl();

        if (!webhookUrl || !repositories?.length) {
            return;
        }

        // Usar método centralizado para determinar o owner correto
        const owner = await this.getCorrectOwner(githubAuthDetail, octokit);

        try {
            for (const repo of repositories) {
                const { data: webhooks } = await octokit.repos.listWebhooks({
                    owner: owner,
                    repo: repo.name,
                });

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

    private getGithubWebhookUrl(): string | undefined {
        return this.configService.get<string>(
            'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
        );
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

            const files = tree.tree
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
            content: null as string | null,
        };

        const cacheKey = `gh:contents:${owner}/${repo}@${branch}:${file.path}`;
        const cached = await this.cacheService.getFromCache<string | null>(
            cacheKey,
        );
        if (cached !== undefined && cached !== null) {
            fileWithContent.content = cached;
            return fileWithContent;
        }

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
                await this.cacheService.addToCache(
                    cacheKey,
                    fileWithContent.content,
                    5 * 60 * 1000,
                );
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

        const allReviews = await octokit.paginate(
            octokit.rest.pulls.listReviews,
            {
                owner: githubAuth.org,
                repo: repository.name,
                pull_number: prNumber,
                per_page: 100,
            },
        );

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

        const lastReview = myReviews.at(-1);

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

            const fullGithubUrl = `${this.getGithubWebBaseUrl(githubAuthDetail.host)}/${params?.repository?.fullName}`;

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
                githubHost: githubAuthDetail.host,
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
        githubHost?: string;
    }): string {
        const { criticalComments, orgName, prNumber, repository, githubHost } =
            params;

        const criticalIssuesSummaryArray =
            this.getCriticalIssuesSummaryArray(criticalComments);

        const listOfCriticalIssues = criticalIssuesSummaryArray
            .map((criticalIssue) => {
                const commentId = criticalIssue.id;
                const summary = criticalIssue.oneSentenceSummary;

                const link =
                    !orgName || !repository?.name || !prNumber || !commentId
                        ? ''
                        : `${this.getGithubWebBaseUrl(githubHost)}/${orgName}/${repository.name}/pull/${prNumber}#discussion_r${commentId}`;

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

        const cacheKey = `gh:user:${organizationAndTeamData.organizationId}:${username.toLowerCase()}`;
        const cached = await this.cacheService.getFromCache<any | null>(
            cacheKey,
        );
        if (cached !== null && cached !== undefined) {
            return cached;
        }

        try {
            const octokit = await this.instanceOctokit(organizationAndTeamData);

            const userResponse = await octokit.rest.users.getByUsername({
                username: username,
            });

            const userData = userResponse.data;

            // 24h TTL. User identity (login, name, email) changes rarely
            // — and when it does, our save flow doesn't depend on
            // realtime freshness. A long TTL lets follow-up saves of
            // the same PR (webhook handler + pipeline-internal save)
            // hit cache instead of refetching 4× per review.
            await this.cacheService.addToCache(
                cacheKey,
                userData,
                24 * 60 * 60 * 1000,
            );

            return userData;
        } catch (error) {
            if (error?.response?.status === 404) {
                // 24h null-cache: a deleted/nonexistent GitHub user
                // doesn't reappear within a working day, and a cached
                // null saves the round-trip when a stale reviewer is
                // referenced repeatedly across saves.
                await this.cacheService.addToCache(
                    cacheKey,
                    null,
                    24 * 60 * 60 * 1000,
                );
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

    // Batch-fetch many users in a single GraphQL request using login
    // aliases. Reads from the same Redis cache as `getUserByUsername`
    // (key `gh:user:{orgId}:{login}`), so an entry warmed by either
    // path is reused by both. Designed to be called as a pre-flight
    // before extractUser/extractUsers fans out per-user, eliminating
    // the N parallel REST round-trips during PR saves.
    //
    // Failure mode is opportunistic: on any GraphQL error this method
    // logs and returns whatever it has so far. Callers proceed to
    // their per-user REST path; uncached users pay the original cost.
    public async getUsersByUsername(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        usernames: string[];
    }): Promise<Map<string, any>> {
        const { organizationAndTeamData, usernames } = params;
        const result = new Map<string, any>();

        if (!usernames?.length) return result;

        // Dedupe & normalize. GitHub usernames are case-insensitive.
        const normalized = Array.from(
            new Set(
                usernames
                    .filter((u) => typeof u === 'string' && u.length > 0)
                    .map((u) => u.toLowerCase()),
            ),
        );

        const makeCacheKey = (login: string) =>
            `gh:user:${organizationAndTeamData?.organizationId}:${login}`;

        // 1. Cache lookup. Matches existing getUserByUsername semantics:
        //    cached null falls through to refetch (the function reads
        //    it as "absent"), so we re-batch nulls. With the 24h TTL
        //    that's still much cheaper than the original 10min churn.
        const misses: string[] = [];
        for (const login of normalized) {
            const cached = await this.cacheService.getFromCache<any | null>(
                makeCacheKey(login),
            );
            if (cached !== null && cached !== undefined) {
                result.set(login, cached);
            } else {
                misses.push(login);
            }
        }

        if (misses.length === 0) return result;

        // 2. GraphQL batch fetch. Aliases u0..uN; GitHub allows up to
        //    ~100 in one query but we cap at 50 to stay consistent with
        //    the file-content batch (smaller payload, less blast radius
        //    on transient errors).
        const BATCH_SIZE = 50;
        let graphqlClient: any;
        try {
            graphqlClient = await this.instanceGraphQL(
                organizationAndTeamData,
            );
        } catch (err) {
            this.logger.warn({
                message:
                    'instanceGraphQL failed for getUsersByUsername — skipping batch (caller falls back to per-user REST)',
                context: GithubService.name,
                error: err,
                metadata: { organizationAndTeamData },
            });
            return result;
        }

        for (let i = 0; i < misses.length; i += BATCH_SIZE) {
            const batch = misses.slice(i, i + BATCH_SIZE);
            const varDefs: string[] = [];
            const fields: string[] = [];
            const variables: Record<string, any> = {};

            batch.forEach((login, idx) => {
                varDefs.push(`$u${idx}: String!`);
                fields.push(
                    `u${idx}: user(login: $u${idx}) { login databaseId name email }`,
                );
                variables[`u${idx}`] = login;
            });

            const query = `
                query(${varDefs.join(', ')}) {
                    ${fields.join('\n                    ')}
                }
            `;

            try {
                const response: any = await graphqlClient(query, variables);

                for (let j = 0; j < batch.length; j++) {
                    const login = batch[j];
                    const gqlUser = response?.[`u${j}`];
                    const cacheKey = makeCacheKey(login);

                    if (gqlUser) {
                        // Map GraphQL shape → REST-like minimal shape
                        // so downstream consumers (`extractUser` reads
                        // `.email`, `.name`, `.id`) see what they
                        // expect from `getUserByUsername`.
                        const userData = {
                            login: gqlUser.login,
                            id: gqlUser.databaseId,
                            name: gqlUser.name,
                            email: gqlUser.email,
                            type: 'User',
                        };
                        result.set(login, userData);
                        await this.cacheService.addToCache(
                            cacheKey,
                            userData,
                            24 * 60 * 60 * 1000,
                        );
                    } else {
                        // Null result = user not found. Cache the null
                        // with the same 24h TTL as getUserByUsername's
                        // 404 path so future per-user lookups also
                        // short-circuit (matching shape).
                        await this.cacheService.addToCache(
                            cacheKey,
                            null,
                            24 * 60 * 60 * 1000,
                        );
                    }
                }
            } catch (err) {
                this.logger.warn({
                    message:
                        'GraphQL batch user fetch failed — partial results returned; caller falls back to per-user REST for the rest',
                    context: GithubService.name,
                    error: err,
                    metadata: {
                        organizationAndTeamData,
                        batchSize: batch.length,
                    },
                });
                // Don't process more batches if one fails — they're
                // independent but a single GraphQL error usually
                // indicates auth/quota issue that won't recover within
                // the same request.
                break;
            }
        }

        return result;
    }

    getUserByEmailOrName(_params: {
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
            const userOctokit = this.createUserOctokitClient({
                auth: token,
                host: githubAuthDetail.host,
            });
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

            const webhookUrl = this.configService.get<string>(
                'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
            );

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
        repositories?: Repositories[];
    }): Promise<void> {
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
            try {
                const authDetails = await this.getGithubAuthDetails(
                    params.organizationAndTeamData,
                );

                const octokit = await this.instanceOctokit(
                    params.organizationAndTeamData,
                );

                const repositories =
                    params.repositories ??
                    (await this.findOneByOrganizationAndTeamDataAndConfigKey(
                        params.organizationAndTeamData,
                        IntegrationConfigKey.REPOSITORIES,
                    ));

                if (repositories) {
                    // Usar método centralizado para determinar o owner correto
                    const owner = await this.getCorrectOwner(
                        authDetails,
                        octokit,
                    );

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
            } catch (error) {
                this.logger.error({
                    message:
                        'Error authenticating for webhook deletion in TOKEN mode',
                    context: this.deleteWebhook.name,
                    error: error,
                    metadata: {
                        organizationAndTeamData: params.organizationAndTeamData,
                    },
                });
            }
        }
    }

    //#region Get Repository Tree
    async getRepositoryTree(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
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
            } catch {
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
    }): Promise<TreeItem[]> {
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
                sha: pullRequest?.head?.sha ?? '',
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
                sha: pullRequest?.base?.sha ?? '',
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
