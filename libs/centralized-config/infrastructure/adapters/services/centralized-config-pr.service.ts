import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CentralizedConfigSyncUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-sync.use-case';
import * as yaml from 'js-yaml';

import { IntegrationConfigKey, ParametersKey } from '@libs/core/domain/enums';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    KodyRuleCentralizedStatus,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    CodeReviewParameter,
    RepositoryCodeReviewConfig,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import {
    CentralizedConfigActivePullRequest,
    CentralizedConfigParameter,
} from '@libs/organization/domain/parameters/types/configValue.type';
import { buildGroupFolderName } from '@libs/centralized-config/utils/path-encoder';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PullRequestFileChange } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

export type CentralizedMutationMode = 'direct' | 'centralized-pr';

export interface CentralizedPrMetadata {
    mode: CentralizedMutationMode;
    prUrl?: string;
    prNumber?: number;
    reused?: boolean;
    pending?: boolean;
    message?: string;
}

type Resolvable<T> = T | ((context: { repositoryFolder: string }) => T);

export interface CentralizedMutationPullRequestRequest {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId?: string;
    files: Resolvable<PullRequestFileChange[]>;
    title: Resolvable<string>;
    description: Resolvable<string>;
    commitMessage: Resolvable<string>;
    sourceBranch: Resolvable<string>;
    author?: { name: string; email?: string };
    centralizedModeMessage?: string;
}

export interface BuildCentralizedPathParams {
    repositoryFolder: string;
    relativePath: string;
}

@Injectable()
export class CentralizedConfigPrService {
    private readonly logger = createLogger(CentralizedConfigPrService.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly moduleRef: ModuleRef,
        private readonly codeManagementService: CodeManagementService,
    ) {}

    private async getSyncUseCase(): Promise<CentralizedConfigSyncUseCase> {
        return this.moduleRef.resolve(CentralizedConfigSyncUseCase, undefined, {
            strict: false,
        });
    }

    async handleTrackedPullRequestClose(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { id?: string; name?: string };
        pullRequestNumber?: number;
        merged: boolean;
    }): Promise<{ shouldSync: boolean }> {
        const matchedTrackedPullRequest =
            await this.clearActivePullRequestMetadataIfMatching({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                pullRequestNumber: params.pullRequestNumber,
            });

        if (matchedTrackedPullRequest && !params.merged) {
            await this.cleanupPendingProposedKodyRules(
                params.organizationAndTeamData.organizationId,
            );

            return {
                shouldSync: false,
            };
        }

        return {
            shouldSync: params.merged,
        };
    }

    async getCentralizedRepositoryIfEnabled(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ id: string; name: string } | null> {
        const centralizedConfig = await this.getCentralizedConfigParameter(
            organizationAndTeamData,
        );

        if (!centralizedConfig?.enabled) {
            return null;
        }

        const centralizedRepository = centralizedConfig.repository;

        if (!centralizedRepository?.id || !centralizedRepository?.name) {
            throw new Error(
                'Centralized config is enabled, but no centralized repository is configured',
            );
        }

        return {
            id: centralizedRepository.id,
            name: centralizedRepository.name,
        };
    }

    async createPullRequestInCentralizedRepo(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        files: PullRequestFileChange[];
        title: string;
        description: string;
        commitMessage: string;
        sourceBranch: string;
        targetBranch?: string;
        author?: { name: string; email?: string };
    }): Promise<{ prUrl: string; prNumber?: number }> {
        const pr = await this.codeManagementService.createPullRequestWithFiles({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            files: params.files,
            title: params.title,
            description: params.description,
            commitMessage: params.commitMessage,
            sourceBranch: params.sourceBranch,
            targetBranch: params.targetBranch,
            author: this.resolveAuthor(params.author),
        });

        if (!pr?.prURL) {
            this.logger.error({
                message:
                    'Failed to create pull request for centralized configuration mutation',
                context: CentralizedConfigPrService.name,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                    title: params.title,
                    files: params.files.map((file) => file.path),
                },
            });

            throw new Error(
                'Failed to create pull request for centralized configuration mutation',
            );
        }

        return {
            prUrl: pr.prURL,
            prNumber: pr.number,
        };
    }

    async resolveRepositoryFolderName(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId?: string,
    ): Promise<string> {
        if (!repositoryId || repositoryId === 'global') {
            return 'global';
        }

        const repositories =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

        const found = repositories?.find((repo) => repo.id === repositoryId);
        return found?.name || repositoryId;
    }

    async createMutationPullRequestIfEnabled(
        params: CentralizedMutationPullRequestRequest,
    ): Promise<CentralizedPrMetadata> {
        const centralizedConfig = await this.getCentralizedConfigParameter(
            params.organizationAndTeamData,
        );

        const centralizedRepository =
            await this.getCentralizedRepositoryIfEnabled(
                params.organizationAndTeamData,
            );

        if (!centralizedRepository) {
            return { mode: 'direct' };
        }

        const repositoryFolder = await this.resolveRepositoryFolderName(
            params.organizationAndTeamData,
            params.repositoryId,
        );

        const context = { repositoryFolder };

        const resolvedFiles = this.resolveValue(params.files, context);
        const resolvedTitle = this.resolveValue(params.title, context);
        const resolvedDescription = this.resolveValue(
            params.description,
            context,
        );
        const resolvedCommitMessage = this.resolveValue(
            params.commitMessage,
            context,
        );

        const targetBranch = await this.codeManagementService.getDefaultBranch({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: centralizedRepository,
        });

        const reusedPullRequest = await this.tryReuseTrackedPullRequest({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: centralizedRepository,
            trackedPullRequest: centralizedConfig?.activePullRequest,
            files: resolvedFiles,
            commitMessage: resolvedCommitMessage,
            targetBranch,
            author: params.author,
        });

        if (reusedPullRequest) {
            return {
                mode: 'centralized-pr',
                prUrl: reusedPullRequest.prUrl,
                prNumber: reusedPullRequest.prNumber,
                reused: true,
                pending: true,
                message:
                    params.centralizedModeMessage ||
                    'Centralized config is enabled. Change queued into the active centralized pull request.',
            };
        }

        const discoveredReusedPullRequest =
            await this.tryDiscoverAndReuseTrackedPullRequest({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: centralizedRepository,
                files: resolvedFiles,
                commitMessage: resolvedCommitMessage,
                targetBranch,
                author: params.author,
            });

        if (discoveredReusedPullRequest) {
            return {
                mode: 'centralized-pr',
                prUrl: discoveredReusedPullRequest.prUrl,
                prNumber: discoveredReusedPullRequest.prNumber,
                reused: true,
                pending: true,
                message:
                    params.centralizedModeMessage ||
                    'Centralized config is enabled. Change queued into the active centralized pull request.',
            };
        }

        const sourceBranch = this.resolveValue(params.sourceBranch, context);

        const pr = await this.createPullRequestInCentralizedRepo({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: centralizedRepository,
            files: resolvedFiles,
            title: resolvedTitle,
            description: resolvedDescription,
            commitMessage: resolvedCommitMessage,
            sourceBranch,
            targetBranch,
            author: params.author,
        });

        const now = new Date().toISOString();
        await this.persistActivePullRequestMetadata(
            params.organizationAndTeamData,
            {
                prUrl: pr.prUrl,
                prNumber: pr.prNumber,
                sourceBranch,
                targetBranch,
                repository: centralizedRepository,
                createdAt: now,
                updatedAt: now,
            },
        );

        return {
            mode: 'centralized-pr',
            prUrl: pr.prUrl,
            prNumber: pr.prNumber,
            reused: false,
            pending: true,
            message:
                params.centralizedModeMessage ||
                'Centralized config is enabled. Change proposed through pull request instead of direct persistence.',
        };
    }

    async clearActivePullRequestMetadata(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const centralizedConfig = await this.getCentralizedConfigParameter(
            organizationAndTeamData,
        );

        if (
            !centralizedConfig?.enabled ||
            !centralizedConfig.activePullRequest
        ) {
            return;
        }

        await this.parametersService.createOrUpdateConfig(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                ...centralizedConfig,
                activePullRequest: null,
            },
            organizationAndTeamData,
        );
    }

    async clearActivePullRequestMetadataIfMatching(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { id?: string; name?: string };
        pullRequestNumber?: number;
    }): Promise<boolean> {
        const centralizedConfig = await this.getCentralizedConfigParameter(
            params.organizationAndTeamData,
        );

        const trackedPullRequest = centralizedConfig?.activePullRequest;

        if (!centralizedConfig?.enabled || !trackedPullRequest) {
            return false;
        }

        if (
            this.normalizeRepositoryId(params.repository?.id) &&
            this.normalizeRepositoryId(trackedPullRequest.repository?.id) &&
            this.normalizeRepositoryId(params.repository?.id) !==
                this.normalizeRepositoryId(trackedPullRequest.repository?.id)
        ) {
            return false;
        }

        const trackedNumber =
            trackedPullRequest.prNumber ||
            this.extractPullRequestNumber(trackedPullRequest.prUrl);

        if (
            params.pullRequestNumber &&
            trackedNumber !== params.pullRequestNumber
        ) {
            return false;
        }

        await this.parametersService.createOrUpdateConfig(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                ...centralizedConfig,
                activePullRequest: null,
            },
            params.organizationAndTeamData,
        );

        return true;
    }

    buildCentralizedPath(params: BuildCentralizedPathParams): string {
        if (params.repositoryFolder === 'global') {
            return params.relativePath;
        }

        return `${params.repositoryFolder}/${params.relativePath}`;
    }

    buildDirectoryGroupConfigPath(
        repositoryFolder: string,
        groupFolderName: string,
    ): string {
        if (repositoryFolder === 'global') {
            return `${groupFolderName}/kodus-config.yml`;
        }

        return `${repositoryFolder}/${groupFolderName}/kodus-config.yml`;
    }

    buildDirectoryGroupRulesPath(
        repositoryFolder: string,
        groupFolderName: string,
        rulesDirectory: string,
        fileName: string,
    ): string {
        if (repositoryFolder === 'global') {
            return `${groupFolderName}/.kody-rules/${rulesDirectory}/${fileName}`;
        }

        return `${repositoryFolder}/${groupFolderName}/.kody-rules/${rulesDirectory}/${fileName}`;
    }

    async resolveDirectoryGroupFolderName(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string | undefined,
        directoryId: string | undefined,
    ): Promise<string | null> {
        if (!repositoryId || !directoryId) {
            return null;
        }

        const parameter = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );
        const configValue = parameter?.configValue as
            | CodeReviewParameter
            | undefined;
        const repository = (configValue?.repositories ?? []).find(
            (repo: RepositoryCodeReviewConfig) =>
                String(repo.id) === String(repositoryId),
        );
        const directory = (repository?.directories ?? []).find(
            (dir) => String(dir.id) === String(directoryId),
        );
        const paths = (directory?.folders ?? [])
            .map((f) => f.path)
            .filter((path): path is string => typeof path === 'string');

        if (paths.length === 0) {
            return null;
        }

        try {
            return buildGroupFolderName(paths);
        } catch {
            return null;
        }
    }

    sanitizeFileName(name?: string, fallback = 'item', maxLength = 30): string {
        const normalized = (name || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, maxLength);

        return normalized || fallback;
    }

    async getCentralizedConfigWithValidatedPullRequest(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CentralizedConfigParameter | null> {
        const centralizedConfig = await this.getCentralizedConfigParameter(
            organizationAndTeamData,
        );

        if (
            !centralizedConfig?.enabled ||
            !centralizedConfig.activePullRequest
        ) {
            return centralizedConfig;
        }

        const centralizedRepository =
            await this.getCentralizedRepositoryIfEnabled(
                organizationAndTeamData,
            );

        if (!centralizedRepository) {
            return centralizedConfig;
        }

        const trackedPullRequest = centralizedConfig.activePullRequest;
        const trackedPrNumber =
            trackedPullRequest.prNumber ||
            this.extractPullRequestNumber(trackedPullRequest.prUrl);

        if (
            this.normalizeRepositoryId(trackedPullRequest.repository?.id) &&
            this.normalizeRepositoryId(trackedPullRequest.repository?.id) !==
                this.normalizeRepositoryId(centralizedRepository.id)
        ) {
            await this.clearActivePullRequestMetadata(organizationAndTeamData);

            return {
                ...centralizedConfig,
                activePullRequest: null,
            };
        }

        if (!trackedPrNumber) {
            await this.clearActivePullRequestMetadata(organizationAndTeamData);

            return {
                ...centralizedConfig,
                activePullRequest: null,
            };
        }

        try {
            const trackedPullRequestState =
                await this.codeManagementService.getPullRequest({
                    organizationAndTeamData,
                    repository: centralizedRepository,
                    prNumber: trackedPrNumber,
                });

            if (
                trackedPullRequestState &&
                trackedPullRequestState.state === PullRequestState.OPENED
            ) {
                return centralizedConfig;
            }

            await this.clearActivePullRequestMetadata(organizationAndTeamData);

            await this.triggerBestEffortSyncAfterTrackedPullRequestClosed({
                organizationAndTeamData,
                repository: centralizedRepository,
                state: trackedPullRequestState?.state,
                pullRequestNumber: trackedPrNumber,
            });

            return {
                ...centralizedConfig,
                activePullRequest: null,
            };
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to validate tracked centralized pull request for config read. Returning stale active pull request metadata.',
                context: CentralizedConfigPrService.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationAndTeamData,
                    trackedPrNumber,
                },
            });

            return centralizedConfig;
        }
    }

    async getScopedKodusConfigFileContent(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        directoryPath?: string;
    }): Promise<Record<string, any> | null> {
        const centralizedRepository =
            await this.getCentralizedRepositoryIfEnabled(
                params.organizationAndTeamData,
            );

        if (!centralizedRepository) {
            return null;
        }

        const centralizedConfig =
            await this.getCentralizedConfigWithValidatedPullRequest(
                params.organizationAndTeamData,
            );

        const branchRef = await this.resolveScopedConfigReadBranchRef({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: centralizedRepository,
            trackedPullRequest: centralizedConfig?.activePullRequest,
        });

        const repositoryFolder = await this.resolveRepositoryFolderName(
            params.organizationAndTeamData,
            params.repositoryId,
        );

        const path = this.buildCentralizedPath({
            repositoryFolder,
            relativePath: this.buildKodusConfigRelativePath(
                params.directoryPath,
            ),
        });

        try {
            const response =
                await this.codeManagementService.getRepositoryContentFile({
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: centralizedRepository,
                    file: { filename: path },
                    pullRequest: {
                        head: { ref: branchRef },
                        base: { ref: branchRef },
                    },
                });

            if (!response?.data?.content) {
                return null;
            }

            const rawContent =
                response.data.encoding === 'base64'
                    ? Buffer.from(response.data.content, 'base64').toString(
                          'utf-8',
                      )
                    : response.data.content;

            const parsed = yaml.load(rawContent);

            if (
                !parsed ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed)
            ) {
                return null;
            }

            return parsed as Record<string, any>;
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to fetch scoped kodus-config.yml content from centralized repository',
                context: CentralizedConfigPrService.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId: params.repositoryId,
                    directoryPath: params.directoryPath,
                    path,
                    branchRef,
                },
            });

            return null;
        }
    }

    private resolveValue<T>(
        value: Resolvable<T>,
        context: { repositoryFolder: string },
    ): T {
        return typeof value === 'function'
            ? (value as (context: { repositoryFolder: string }) => T)(context)
            : value;
    }

    private resolveAuthor(author?: { name: string; email?: string }) {
        return (
            author || {
                name: 'kody',
                email: 'kody@kodus.io',
            }
        );
    }

    private async getCentralizedConfigParameter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CentralizedConfigParameter | null> {
        if (!organizationAndTeamData.teamId) {
            return null;
        }

        const parameter = await this.parametersService.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            organizationAndTeamData,
        );

        return (parameter?.configValue as CentralizedConfigParameter) || null;
    }

    private async persistActivePullRequestMetadata(
        organizationAndTeamData: OrganizationAndTeamData,
        activePullRequest: CentralizedConfigActivePullRequest,
    ): Promise<void> {
        const centralizedConfig = await this.getCentralizedConfigParameter(
            organizationAndTeamData,
        );

        if (!centralizedConfig?.enabled) {
            return;
        }

        try {
            await this.parametersService.createOrUpdateConfig(
                ParametersKey.CENTRALIZED_CONFIG,
                {
                    ...centralizedConfig,
                    repository:
                        centralizedConfig.repository ||
                        activePullRequest.repository,
                    activePullRequest,
                },
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to persist centralized active pull request metadata',
                context: CentralizedConfigPrService.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationAndTeamData,
                    prUrl: activePullRequest.prUrl,
                },
            });
        }
    }

    private async tryReuseTrackedPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        trackedPullRequest?: CentralizedConfigActivePullRequest | null;
        files: PullRequestFileChange[];
        commitMessage: string;
        targetBranch: string;
        author?: { name: string; email?: string };
    }): Promise<{ prUrl: string; prNumber?: number } | null> {
        const trackedPullRequest = params.trackedPullRequest;

        if (!trackedPullRequest?.prUrl || !trackedPullRequest.sourceBranch) {
            return null;
        }

        if (
            this.normalizeRepositoryId(trackedPullRequest.repository?.id) &&
            this.normalizeRepositoryId(trackedPullRequest.repository?.id) !==
                this.normalizeRepositoryId(params.repository.id)
        ) {
            await this.clearActivePullRequestMetadata(
                params.organizationAndTeamData,
            );
            return null;
        }

        const trackedPrNumber =
            trackedPullRequest.prNumber ||
            this.extractPullRequestNumber(trackedPullRequest.prUrl);

        if (!trackedPrNumber) {
            await this.clearActivePullRequestMetadata(
                params.organizationAndTeamData,
            );
            return null;
        }

        const trackedPullRequestState =
            await this.codeManagementService.getPullRequest({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: trackedPrNumber,
            });

        if (
            !trackedPullRequestState ||
            trackedPullRequestState.state !== PullRequestState.OPENED
        ) {
            await this.clearActivePullRequestMetadata(
                params.organizationAndTeamData,
            );

            await this.triggerBestEffortSyncAfterTrackedPullRequestClosed({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                state: trackedPullRequestState?.state,
                pullRequestNumber: trackedPrNumber,
            });
            return null;
        }

        const uploadResult = await this.codeManagementService.uploadFiles({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            branchName: trackedPullRequest.sourceBranch,
            baseBranch: trackedPullRequest.targetBranch || params.targetBranch,
            files: params.files,
            message: params.commitMessage,
            author: this.resolveAuthor(params.author),
        });

        if (!uploadResult) {
            this.logger.warn({
                message:
                    'Failed to upload files to tracked centralized pull request branch. A new pull request will be created.',
                context: CentralizedConfigPrService.name,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    prUrl: trackedPullRequest.prUrl,
                    sourceBranch: trackedPullRequest.sourceBranch,
                },
            });

            await this.clearActivePullRequestMetadata(
                params.organizationAndTeamData,
            );
            return null;
        }

        const now = new Date().toISOString();
        await this.persistActivePullRequestMetadata(
            params.organizationAndTeamData,
            {
                ...trackedPullRequest,
                prNumber: trackedPrNumber,
                targetBranch:
                    trackedPullRequest.targetBranch || params.targetBranch,
                createdAt: trackedPullRequest.createdAt || now,
                updatedAt: now,
                repository: trackedPullRequest.repository || params.repository,
            },
        );

        return {
            prUrl: trackedPullRequest.prUrl,
            prNumber: trackedPrNumber,
        };
    }

    private async tryDiscoverAndReuseTrackedPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        files: PullRequestFileChange[];
        commitMessage: string;
        targetBranch: string;
        author?: { name: string; email?: string };
    }): Promise<{ prUrl: string; prNumber?: number } | null> {
        const discoveredTrackedPullRequest =
            await this.discoverSingleOpenCentralizedPullRequest({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                targetBranch: params.targetBranch,
            });

        if (!discoveredTrackedPullRequest) {
            return null;
        }

        const reusedPullRequest = await this.tryReuseTrackedPullRequest({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            trackedPullRequest: discoveredTrackedPullRequest,
            files: params.files,
            commitMessage: params.commitMessage,
            targetBranch: params.targetBranch,
            author: params.author,
        });

        if (!reusedPullRequest) {
            return null;
        }

        return reusedPullRequest;
    }

    private async discoverSingleOpenCentralizedPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        targetBranch: string;
    }): Promise<CentralizedConfigActivePullRequest | null> {
        try {
            const openPullRequests =
                await this.codeManagementService.getPullRequests({
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                    filters: {
                        state: PullRequestState.OPENED,
                    },
                });

            const centralizedOpenPullRequests = (openPullRequests || []).filter(
                (pullRequest) => {
                    const sourceBranch = pullRequest?.head?.ref;
                    const baseBranch = pullRequest?.base?.ref;

                    return (
                        typeof sourceBranch === 'string' &&
                        sourceBranch.startsWith('kodus-centralized-') &&
                        typeof baseBranch === 'string' &&
                        baseBranch === params.targetBranch
                    );
                },
            );

            if (centralizedOpenPullRequests.length !== 1) {
                return null;
            }

            const discoveredPullRequest = centralizedOpenPullRequests[0];

            if (
                !discoveredPullRequest?.prURL ||
                !discoveredPullRequest?.head?.ref
            ) {
                return null;
            }

            const now = new Date().toISOString();
            const discoveredTrackedPullRequest: CentralizedConfigActivePullRequest =
                {
                    prUrl: discoveredPullRequest.prURL,
                    prNumber: discoveredPullRequest.number,
                    sourceBranch: discoveredPullRequest.head.ref,
                    targetBranch:
                        discoveredPullRequest.base?.ref || params.targetBranch,
                    repository: params.repository,
                    createdAt: discoveredPullRequest.created_at || now,
                    updatedAt: now,
                };

            await this.persistActivePullRequestMetadata(
                params.organizationAndTeamData,
                discoveredTrackedPullRequest,
            );

            return discoveredTrackedPullRequest;
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to discover open centralized pull requests for reuse',
                context: CentralizedConfigPrService.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                    targetBranch: params.targetBranch,
                },
            });

            return null;
        }
    }

    private extractPullRequestNumber(url?: string): number | undefined {
        if (!url) {
            return undefined;
        }

        const cleanUrl = url.split('?')[0];
        const segments = cleanUrl.split('/').filter(Boolean);

        for (let index = segments.length - 1; index >= 0; index--) {
            const segment = segments[index];
            if (/^\d+$/.test(segment)) {
                return Number(segment);
            }
        }

        return undefined;
    }

    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    private async resolveScopedConfigReadBranchRef(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        trackedPullRequest?: CentralizedConfigActivePullRequest | null;
    }): Promise<string> {
        const defaultBranch = await this.codeManagementService.getDefaultBranch(
            {
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
            },
        );

        const trackedPullRequest = params.trackedPullRequest;

        if (!trackedPullRequest?.sourceBranch) {
            return defaultBranch;
        }

        if (
            this.normalizeRepositoryId(trackedPullRequest.repository?.id) &&
            this.normalizeRepositoryId(trackedPullRequest.repository?.id) !==
                this.normalizeRepositoryId(params.repository.id)
        ) {
            await this.clearActivePullRequestMetadata(
                params.organizationAndTeamData,
            );
            return defaultBranch;
        }

        const trackedPrNumber =
            trackedPullRequest.prNumber ||
            this.extractPullRequestNumber(trackedPullRequest.prUrl);

        if (!trackedPrNumber) {
            await this.clearActivePullRequestMetadata(
                params.organizationAndTeamData,
            );
            return defaultBranch;
        }

        try {
            const trackedPullRequestState =
                await this.codeManagementService.getPullRequest({
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                    prNumber: trackedPrNumber,
                });

            if (
                trackedPullRequestState &&
                trackedPullRequestState.state === PullRequestState.OPENED
            ) {
                return trackedPullRequest.sourceBranch;
            }

            await this.clearActivePullRequestMetadata(
                params.organizationAndTeamData,
            );

            return defaultBranch;
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to validate tracked centralized pull request for scoped config read. Falling back to default branch.',
                context: CentralizedConfigPrService.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                    trackedPrNumber,
                },
            });

            return defaultBranch;
        }
    }

    private async triggerBestEffortSyncAfterTrackedPullRequestClosed(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        state?: PullRequestState;
        pullRequestNumber: number;
    }): Promise<void> {
        try {
            const syncUseCase = await this.getSyncUseCase();
            await syncUseCase.execute({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Tracked centralized pull request is closed, but post-close centralized sync failed',
                context: CentralizedConfigPrService.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                    state: params.state,
                    pullRequestNumber: params.pullRequestNumber,
                },
            });
        }
    }

    private buildKodusConfigRelativePath(directoryPath?: string): string {
        const normalizedDirectoryPath =
            this.normalizeDirectoryPath(directoryPath);

        if (!normalizedDirectoryPath) {
            return 'kodus-config.yml';
        }

        return `${normalizedDirectoryPath}/kodus-config.yml`;
    }

    private normalizeDirectoryPath(path?: string): string | undefined {
        if (!path) {
            return undefined;
        }

        const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');
        return normalized || undefined;
    }

    private normalizeRepositoryId(
        repositoryId?: string | number | null,
    ): string | undefined {
        if (repositoryId === undefined || repositoryId === null) {
            return undefined;
        }

        return String(repositoryId);
    }

    private async cleanupPendingProposedKodyRules(
        organizationId: string,
    ): Promise<void> {
        const entity =
            await this.kodyRulesService.findByOrganizationId(organizationId);

        if (!entity?.uuid) {
            return;
        }

        const rules = (entity.toJson?.()?.rules || []) as Partial<IKodyRule>[];

        for (const rule of rules) {
            const centralizedStatus = rule.centralizedConfig?.status;
            const isPendingCentralizedStatus =
                centralizedStatus === KodyRuleCentralizedStatus.PENDING_ADD ||
                centralizedStatus === KodyRuleCentralizedStatus.PENDING_EDIT ||
                centralizedStatus === KodyRuleCentralizedStatus.PENDING_DELETE;

            if (!isPendingCentralizedStatus || !rule.uuid) {
                continue;
            }

            if (!rule.centralizedConfig?.path) {
                continue;
            }

            const nextStatus =
                centralizedStatus === KodyRuleCentralizedStatus.PENDING_ADD
                    ? KodyRulesStatus.REJECTED
                    : rule.status;

            await this.kodyRulesService.updateRule(entity.uuid, rule.uuid, {
                ...rule,
                status: nextStatus,
                centralizedConfig: {
                    ...rule.centralizedConfig,
                    status: KodyRuleCentralizedStatus.SYNCED,
                },
            });
        }
    }
}
