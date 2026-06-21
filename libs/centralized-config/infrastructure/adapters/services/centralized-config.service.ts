import { createLogger } from '@kodus/flow';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    ICentralizedConfigService,
    IConfigFileMeta,
    IKodyRuleFileMeta,
} from '@libs/centralized-config/domain/contracts/CentralizedConfigService.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { DeleteRepositoryCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/delete-repository-code-review-parameter.use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/update-or-create-code-review-parameter-use-case';
import { CreateOrUpdatePullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/create-or-update-pull-request-messages.use-case';
import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import {
    buildGroupFolderName,
    parseGroupFolderName,
} from '@libs/centralized-config/utils/path-encoder';
import { Inject, Injectable } from '@nestjs/common';
import path from 'path';
import { CustomMessageConfig } from 'apps/web/src/lib/services/pull-request-messages/types';
import { KodusConfigFile } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { DeepPartial } from 'typeorm';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import {
    IKodyRule,
    KodyRuleCentralizedStatus,
    kodyRuleSchema,
    kodyRulesExampleSchema,
    kodyRulesInheritanceSchema,
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import * as yaml from 'js-yaml';
import { KodyRuleSeverity } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import z from 'zod';
import { TreeItem } from '@libs/core/infrastructure/config/types/general/tree.type';

@Injectable()
export class CentralizedConfigService implements ICentralizedConfigService {
    private readonly logger = createLogger(CentralizedConfigService.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly codeManagementService: CodeManagementService,
        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,
        private readonly deleteRepositoryCodeReviewParameterUseCase: DeleteRepositoryCodeReviewParameterUseCase,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly createOrUpdatePullRequestMessagesUseCase: CreateOrUpdatePullRequestMessagesUseCase,
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly deleteRuleInOrganizationByIdKodyRulesUseCase: DeleteRuleInOrganizationByIdKodyRulesUseCase,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    async validateCentralizedConfig(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { name: string; id: string };
    }): Promise<{
        success: boolean;
        message: string;
    }> {
        const { organizationAndTeamData } = params;

        const centralizedConfigParameter =
            await this.parametersService.findByKey(
                ParametersKey.CENTRALIZED_CONFIG,
                organizationAndTeamData,
            );

        if (
            !centralizedConfigParameter ||
            !centralizedConfigParameter.configValue?.enabled
        ) {
            return {
                success: false,
                message: 'Centralized config is not enabled for this team',
            };
        }

        if (params.repository) {
            const centralizedRepoId =
                centralizedConfigParameter.configValue.repository?.id;

            if (
                centralizedRepoId &&
                params.repository.id !== centralizedRepoId
            ) {
                this.logger.debug({
                    message:
                        'Centralized config is enabled but does not apply to this repository',
                    context: CentralizedConfigService.name,
                    metadata: {
                        organizationAndTeamData,
                        repository: params.repository,
                        centralizedRepoId,
                    },
                });
                return {
                    success: false,
                    message:
                        'Centralized config does not apply to this repository',
                };
            }
        }

        const { repository } = centralizedConfigParameter.configValue;

        if (!repository?.id) {
            this.logger.error({
                message:
                    'Centralized config is enabled, but no repository is configured to store the files',
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                },
            });

            return {
                success: false,
                message:
                    'Centralized config is enabled, but no repository is configured',
            };
        }

        return {
            success: true,
            message: 'Centralized config is valid and enabled',
        };
    }

    async getCentralizedConfigRepository(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ name: string; id: string }> {
        const centralizedConfigParameter =
            await this.parametersService.findByKey(
                ParametersKey.CENTRALIZED_CONFIG,
                organizationAndTeamData,
            );

        if (!centralizedConfigParameter?.configValue?.repository) {
            throw new Error('Centralized config repository not configured');
        }

        return centralizedConfigParameter.configValue.repository;
    }

    async discoverConfigFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<IConfigFileMeta[]> {
        const { organizationAndTeamData, repository } = params;

        const configFilePaths = await this.scanRepositoryTree<IConfigFileMeta>(
            organizationAndTeamData,
            repository,
            (item, resolvedRepoIds) => {
                const fileName = path.basename(item.path);

                if (fileName !== 'kodus-config.yml') return null;

                if (item.path.includes('/.kody-rules/')) return null;

                const dirName = path.dirname(item.path);
                if (dirName === '.') return {}; // Global config

                const directorySegments = dirName.split('/');
                const repoName = directorySegments[0];
                const repoId = resolvedRepoIds.get(repoName.toLowerCase());

                if (!repoId) {
                    this.logger.warn({
                        message: `Could not resolve repository ID for repository name: ${repoName}`,
                        context: CentralizedConfigService.name,
                        metadata: { organizationAndTeamData, repoName },
                    });
                    return null;
                }

                const remainder = directorySegments.slice(1);

                // Repository root config: {repo}/kodus-config.yml
                if (remainder.length === 0) {
                    return {
                        repositoryId: repoId,
                        centralizedDirectoryPath: dirName,
                    };
                }

                // Directory group: {repo}/{encoded-paths}/kodus-config.yml
                // The encoded folder name is a single segment (paths joined by &).
                if (remainder.length === 1) {
                    const decoded = parseGroupFolderName(remainder[0]);
                    if (!decoded) {
                        this.logger.warn({
                            message:
                                'Skipping kodus-config.yml — folder name is not a valid directory group',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                repoName,
                                folder: remainder[0],
                            },
                        });
                        return null;
                    }

                    return {
                        repositoryId: repoId,
                        centralizedDirectoryPath: dirName,
                        directoryPaths: decoded.map((p) =>
                            p.startsWith('/') ? p : `/${p}`,
                        ),
                    };
                }

                this.logger.warn({
                    message:
                        'Skipping kodus-config.yml at unsupported nested path',
                    context: CentralizedConfigService.name,
                    metadata: {
                        organizationAndTeamData,
                        repoName,
                        path: dirName,
                    },
                });
                return null;
            },
        );

        return this.sortConfigFiles(configFilePaths);
    }

    async fetchConfigFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        dir?: string;
        directoryId?: string;
    }) {
        const { organizationAndTeamData, repository, dir, directoryId } =
            params;

        try {
            const file = await this.codeBaseConfigService.getKodusConfigFile({
                organizationAndTeamData,
                repository,
                directoryPath: dir,
                directoryId,
                removeProperties: false,
            });

            return file;
        } catch (error) {
            this.logger.error({
                message:
                    'Error fetching centralized config file from repository',
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    dir,
                    directoryId,
                },
                error,
            });

            return null;
        }
    }

    async synchronizeConfigs(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        configFiles: IConfigFileMeta[];
        actor: {
            organizationId: string;
            source: 'web' | 'sync' | 'cli';
            userEmail: string;
            userId: string;
        };
    }): Promise<{ success: boolean; message: string }> {
        const { organizationAndTeamData, configFiles, actor } = params;

        try {
            const codeReviewConfig = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            const hasGlobalConfigFile = configFiles.some(
                (meta) => !meta.repositoryId,
            );

            if (!codeReviewConfig && !hasGlobalConfigFile) {
                await this.updateOrCreateCodeReviewParameterUseCase.execute({
                    actor,
                    skipAuthorization: true,
                    configValue: {},
                    organizationAndTeamData,
                    repositoryId: 'global',
                });
            }

            const centralizedRepository =
                await this.getCentralizedConfigRepository(
                    organizationAndTeamData,
                );

            for (const configFileMeta of configFiles) {
                try {
                    const {
                        centralizedDirectoryPath,
                        repositoryId,
                        directoryPath,
                        directoryPaths,
                    } = configFileMeta;

                    let configFile;

                    if (!this.isKodyRulesScope(configFileMeta)) {
                        configFile = await this.fetchConfigFile({
                            organizationAndTeamData,
                            repository: centralizedRepository,
                            dir: centralizedDirectoryPath,
                        });
                    }

                    if (!configFile && !this.isKodyRulesScope(configFileMeta)) {
                        this.logger.warn({
                            message:
                                'Config file not found or could not be fetched',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                centralizedDirectoryPath,
                                repositoryId,
                                directoryPath,
                                directoryPaths,
                            },
                        });
                        continue;
                    }

                    let configToSave = {};
                    let configForMessages = {} as KodusConfigFile;

                    if (configFile) {
                        const { customMessages: _, ...restOfConfig } =
                            configFile;
                        configToSave = restOfConfig;
                        configForMessages = configFile;
                    } else {
                        // We know it's a KodyRulesScope missing a file here
                        this.logger.log({
                            message:
                                'Creating empty config placeholder for centralized rules scope',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                centralizedDirectoryPath,
                                repositoryId,
                                directoryPath,
                                directoryPaths,
                            },
                        });
                    }

                    if (directoryPaths && directoryPaths.length > 0) {
                        await this.updateOrCreateCodeReviewParameterUseCase.execute(
                            {
                                actor,
                                skipAuthorization: true,
                                configValue: configToSave,
                                organizationAndTeamData,
                                repositoryId,
                                directoryPaths,
                            },
                        );
                    } else {
                        await this.updateOrCreateCodeReviewParameterUseCase.execute(
                            {
                                actor,
                                skipAuthorization: true,
                                configValue: configToSave,
                                organizationAndTeamData,
                                repositoryId,
                                directoryPath,
                            },
                        );
                    }

                    const syncCustomMessagesResult =
                        await this.syncCustomMessages(
                            configForMessages,
                            configFileMeta,
                            organizationAndTeamData,
                            centralizedRepository,
                            actor,
                        );

                    if (!syncCustomMessagesResult.success) {
                        this.logger.warn({
                            message: configFile
                                ? 'Failed to sync custom messages for config file'
                                : 'Failed to clean custom messages for centralized rules scope',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                centralizedDirectoryPath,
                                repositoryId,
                                directoryPath,
                                syncCustomMessagesMessage:
                                    syncCustomMessagesResult.message,
                            },
                        });
                    }
                } catch (innerError) {
                    this.logger.error({
                        message: `Error processing individual config file: ${configFileMeta.centralizedDirectoryPath}`,
                        context: CentralizedConfigService.name,
                        error: innerError,
                    });
                }
            }

            return {
                success: true,
                message: 'Config files synchronized successfully',
            };
        } catch (error) {
            this.logger.error({
                message: 'Error synchronizing config files',
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    configFilesCount: configFiles.length,
                },
                error,
            });

            return {
                success: false,
                message: 'Error synchronizing config files',
            };
        }
    }

    async removeStaleConfigs(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        configFiles: IConfigFileMeta[];
        actor: {
            organizationId: string;
            source: 'sync' | 'web' | 'cli';
            userEmail: string;
            userId: string;
        };
    }): Promise<{
        success: boolean;
        message: string;
    }> {
        const { organizationAndTeamData, configFiles, actor } = params;

        try {
            const codeReviewConfig = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            if (!codeReviewConfig?.configValue) {
                return {
                    success: true,
                    message: 'No config to clean up',
                };
            }

            const desiredHasGlobalConfig = configFiles.some(
                (meta) => !meta.repositoryId,
            );

            const desiredRepositoryConfigs = new Set<string>(
                configFiles
                    .filter((meta) => meta.repositoryId && !meta.directoryPath)
                    .map((meta) => meta.repositoryId as string),
            );

            const desiredDirectoryConfigsByRepository = new Map<
                string,
                Set<string>
            >();

            const desiredGroupFolderNamesByRepository = new Map<
                string,
                Set<string>
            >();

            const repositoriesWithDeletedDirectories = new Set<string>();

            for (const meta of configFiles) {
                if (!meta.repositoryId) {
                    continue;
                }

                if (meta.directoryPaths && meta.directoryPaths.length > 0) {
                    if (
                        !desiredGroupFolderNamesByRepository.has(
                            meta.repositoryId,
                        )
                    ) {
                        desiredGroupFolderNamesByRepository.set(
                            meta.repositoryId,
                            new Set<string>(),
                        );
                    }

                    try {
                        desiredGroupFolderNamesByRepository
                            .get(meta.repositoryId)
                            ?.add(buildGroupFolderName(meta.directoryPaths));
                    } catch {
                        // Skip metas with invalid path sets.
                    }
                }

                if (meta.directoryPath) {
                    if (
                        !desiredDirectoryConfigsByRepository.has(
                            meta.repositoryId,
                        )
                    ) {
                        desiredDirectoryConfigsByRepository.set(
                            meta.repositoryId,
                            new Set<string>(),
                        );
                    }

                    desiredDirectoryConfigsByRepository
                        .get(meta.repositoryId)
                        ?.add(meta.directoryPath);
                }
            }

            // Reuse existing deletion logic for directory scope removals.
            for (const repository of codeReviewConfig.configValue
                .repositories ?? []) {
                const desiredDirectoryPaths =
                    desiredDirectoryConfigsByRepository.get(repository.id) ??
                    new Set<string>();

                const desiredGroupFolderNames =
                    desiredGroupFolderNamesByRepository.get(repository.id) ??
                    new Set<string>();

                const staleDirectories = (repository.directories ?? []).filter(
                    (directory) => {
                        const primaryPath =
                            directory.folders?.[0]?.path ??
                            (directory as any).path;

                        let dbGroupFolderName: string | null = null;
                        if (
                            directory.folders &&
                            directory.folders.length > 0
                        ) {
                            try {
                                dbGroupFolderName = buildGroupFolderName(
                                    directory.folders.map((f) => f.path),
                                );
                            } catch {
                                dbGroupFolderName = null;
                            }
                        }

                        const isTrackedByGroup =
                            dbGroupFolderName !== null &&
                            desiredGroupFolderNames.has(dbGroupFolderName);
                        const isTrackedByPath =
                            primaryPath &&
                            desiredDirectoryPaths.has(primaryPath);

                        return !isTrackedByGroup && !isTrackedByPath;
                    },
                );

                for (const staleDirectory of staleDirectories) {
                    await this.deleteRepositoryCodeReviewParameterUseCase.execute(
                        {
                            teamId: organizationAndTeamData.teamId,
                            repositoryId: repository.id,
                            directoryId: staleDirectory.id,
                            organizationAndTeamData,
                            actor,
                        },
                    );

                    repositoriesWithDeletedDirectories.add(repository.id);
                }
            }

            let refreshedCodeReviewConfig =
                await this.parametersService.findByKey(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData,
                );

            if (!refreshedCodeReviewConfig?.configValue) {
                return {
                    success: true,
                    message: 'Config cleaned up successfully',
                };
            }

            for (const repository of refreshedCodeReviewConfig.configValue
                .repositories ?? []) {
                const shouldKeepRepositoryConfig = desiredRepositoryConfigs.has(
                    repository.id,
                );

                if (shouldKeepRepositoryConfig) {
                    continue;
                }

                const hasDirectories =
                    (repository.directories ?? []).length > 0;
                if (hasDirectories) {
                    continue;
                }

                const hasRepositoryConfig =
                    Boolean(repository.isSelected) ||
                    Boolean(
                        repository.configs &&
                        Object.keys(repository.configs).length > 0,
                    );

                const shouldTriggerRepositoryRemovalSideEffects =
                    hasRepositoryConfig ||
                    repositoriesWithDeletedDirectories.has(repository.id);

                if (!shouldTriggerRepositoryRemovalSideEffects) {
                    continue;
                }

                await this.deleteRepositoryCodeReviewParameterUseCase.execute({
                    teamId: organizationAndTeamData.teamId,
                    repositoryId: repository.id,
                    organizationAndTeamData,
                    actor,
                });
            }

            refreshedCodeReviewConfig = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            if (!refreshedCodeReviewConfig?.configValue) {
                return {
                    success: true,
                    message: 'Config cleaned up successfully',
                };
            }

            let hasChanges = false;

            const reconciledConfig: CodeReviewParameter = {
                ...refreshedCodeReviewConfig.configValue,
                configs: desiredHasGlobalConfig
                    ? refreshedCodeReviewConfig.configValue.configs
                    : {},
                repositories: (
                    refreshedCodeReviewConfig.configValue.repositories ?? []
                ).map((repository) => {
                    const shouldKeepRepositoryConfig =
                        desiredRepositoryConfigs.has(repository.id);

                    const nextRepository = {
                        ...repository,
                        configs: shouldKeepRepositoryConfig
                            ? repository.configs
                            : {},
                        isSelected:
                            shouldKeepRepositoryConfig ||
                            (repository.directories ?? []).length > 0,
                    };

                    if (
                        !hasChanges &&
                        (nextRepository.isSelected !== repository.isSelected ||
                            JSON.stringify(nextRepository.configs) !==
                                JSON.stringify(repository.configs))
                    ) {
                        hasChanges = true;
                    }

                    return nextRepository;
                }),
            };

            if (
                !hasChanges &&
                JSON.stringify(reconciledConfig.configs) !==
                    JSON.stringify(
                        refreshedCodeReviewConfig.configValue.configs,
                    )
            ) {
                hasChanges = true;
            }

            const staleMessagesResult = await this.removeStaleCustomMessages(
                configFiles,
                organizationAndTeamData,
            );

            if (!staleMessagesResult.success) {
                this.logger.warn({
                    message: 'Failed to remove stale custom messages',
                    context: CentralizedConfigService.name,
                    metadata: {
                        organizationAndTeamData,
                        removeStaleMessagesMessage: staleMessagesResult.message,
                    },
                });
            }

            if (!hasChanges) {
                return {
                    success: true,
                    message: 'No stale configs to remove',
                };
            }

            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                reconciledConfig,
                organizationAndTeamData,
            );

            return {
                success: true,
                message: 'Stale configs removed successfully',
            };
        } catch (error) {
            this.logger.error({
                message: 'Error removing stale configs',
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    configFilesCount: configFiles.length,
                },
                error,
            });

            return {
                success: false,
                message: 'Error removing stale configs',
            };
        }
    }

    private sortConfigFiles(configFiles: IConfigFileMeta[]): IConfigFileMeta[] {
        const getPriority = (configFile: IConfigFileMeta) => {
            if (!configFile.repositoryId) {
                return 0;
            }

            if (!configFile.directoryPath) {
                return 1;
            }

            return 2;
        };

        return [...configFiles].sort((a, b) => {
            const priorityA = getPriority(a);
            const priorityB = getPriority(b);

            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }

            const depthA =
                a.directoryPath?.split('/').filter(Boolean).length ?? 0;
            const depthB =
                b.directoryPath?.split('/').filter(Boolean).length ?? 0;

            return depthA - depthB;
        });
    }

    private isKodyRulesScope(configFileMeta: IConfigFileMeta): boolean {
        const centralizedDirectoryPath =
            configFileMeta.centralizedDirectoryPath;

        if (!centralizedDirectoryPath) {
            return false;
        }

        return /(^|\/)\.kody-rules\/(review|memories)(\/|$)/.test(
            centralizedDirectoryPath,
        );
    }

    private async resolveGroupIdByExactPaths(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
        paths: string[],
    ): Promise<string | undefined> {
        const param = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );
        const configValue = param?.configValue as
            | CodeReviewParameter
            | undefined;
        const repo = configValue?.repositories?.find(
            (r) => String(r.id) === String(repositoryId),
        );
        if (!repo?.directories) return undefined;

        const normalize = (p: string): string =>
            p.startsWith('/') ? p : `/${p}`;
        const want = [...paths].map(normalize).sort();

        for (const dir of repo.directories) {
            const folders = dir.folders ?? [];
            if (folders.length !== want.length) continue;
            const got = folders.map((f) => normalize(f.path)).sort();
            const match = got.every((p, i) => p === want[i]);
            if (match) return String(dir.id);
        }
        return undefined;
    }

    //#region Custom Messages Sync Helpers
    private async syncCustomMessages(
        configFile: KodusConfigFile,
        configFileMeta: IConfigFileMeta,
        organizationAndTeamData: OrganizationAndTeamData,
        centralizedRepository: { name: string; id: string },
        actor: {
            organizationId: string;
            source: 'web' | 'sync' | 'cli';
            userEmail: string;
            userId: string;
        },
    ): Promise<{
        success: boolean;
        message: string;
    }> {
        const { repositoryId, directoryPath } = configFileMeta;

        // 1. Determine config level and resolve directory ID FIRST
        let configLevel: ConfigLevel;
        let repositoryIdForMessages: string | undefined;
        let directoryId: string | undefined;

        let targetRepo: { id: string; name: string } | undefined;
        if (repositoryId) {
            const repositories =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    Repositories[]
                >(IntegrationConfigKey.REPOSITORIES, {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                });

            const foundRepo = repositories?.find(
                (repo) => repo.id === repositoryId,
            );

            if (foundRepo && foundRepo.name) {
                targetRepo = { id: foundRepo.id, name: foundRepo.name };
            }
        }

        if (!repositoryId) {
            configLevel = ConfigLevel.GLOBAL;
            repositoryIdForMessages = 'global';
        } else if (!directoryPath) {
            configLevel = ConfigLevel.REPOSITORY;
            repositoryIdForMessages = repositoryId;
        } else {
            configLevel = ConfigLevel.DIRECTORY;
            repositoryIdForMessages = repositoryId;

            if (!targetRepo) {
                const message =
                    'Could not find target repository for directory ID resolution';
                this.logger.warn({
                    message,
                    context: CentralizedConfigService.name,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId,
                        directoryPath,
                    },
                });
                return { success: false, message };
            }

            try {
                directoryId =
                    await this.codeBaseConfigService.getDirectoryIdForPath(
                        organizationAndTeamData,
                        targetRepo,
                        directoryPath,
                    );

                if (!directoryId) {
                    const message = `Could not resolve directory ID for custom messages`;
                    this.logger.warn({
                        message,
                        context: CentralizedConfigService.name,
                        metadata: {
                            organizationAndTeamData,
                            repositoryId,
                            directoryPath,
                        },
                    });
                    return { success: false, message };
                }
            } catch (error) {
                const message = `Error resolving directory ID for custom messages`;
                this.logger.error({
                    message,
                    context: CentralizedConfigService.name,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId,
                        directoryPath,
                    },
                    error,
                });
                return { success: false, message };
            }
        }

        // 2. Now check if custom messages exist in the file
        const customMessages = configFile.customMessages;

        if (!customMessages) {
            try {
                const existingEntity =
                    await this.pullRequestMessagesService?.findOne({
                        organizationId: organizationAndTeamData.organizationId,
                        configLevel,
                        repositoryId: repositoryIdForMessages,
                        directoryId,
                    });

                if (existingEntity?.uuid) {
                    this.logger.log({
                        message:
                            'Removing orphaned custom messages (file exists but messages block was removed)',
                        context: CentralizedConfigService.name,
                        metadata: {
                            organizationAndTeamData,
                            configLevel,
                            repositoryId: repositoryIdForMessages,
                            directoryId,
                            entityUuid: existingEntity.uuid,
                        },
                    });

                    await this.pullRequestMessagesService.delete(
                        existingEntity.uuid,
                    );

                    return {
                        success: true,
                        message:
                            'Orphaned custom messages removed successfully',
                    };
                }
            } catch (error) {
                this.logger.warn({
                    message:
                        'Failed to check or remove orphaned custom messages',
                    context: CentralizedConfigService.name,
                    metadata: {
                        organizationAndTeamData,
                        configLevel,
                        repositoryId: repositoryIdForMessages,
                    },
                    error,
                });
            }

            return {
                success: true,
                message: 'No custom messages to sync',
            };
        }

        // 3. Proceed with normal creation/updating if custom messages DO exist
        try {
            const resolvedCustomMessages =
                await this.resolveCustomMessagesWithInheritance(
                    organizationAndTeamData,
                    configLevel,
                    targetRepo,
                    repositoryIdForMessages,
                    directoryId,
                    directoryPath,
                    customMessages,
                );

            const pullRequestMessages = {
                organizationId: organizationAndTeamData.organizationId,
                configLevel,
                repositoryId: repositoryIdForMessages,
                directoryId,
                startReviewMessage: resolvedCustomMessages.startReviewMessage,
                endReviewMessage: resolvedCustomMessages.endReviewMessage,
                globalSettings: resolvedCustomMessages.globalSettings,
            };

            const userInfo = {
                uuid: actor.userId,
                email: actor.userEmail,
                organization: { uuid: actor.organizationId },
            };

            await this.createOrUpdatePullRequestMessagesUseCase.execute(
                userInfo,
                pullRequestMessages,
                {
                    skipAuthorization: true,
                    skipCentralizedPr: true,
                },
            );

            const message = 'Custom messages synced successfully';
            this.logger.log({
                message,
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    configLevel,
                    repositoryId: repositoryIdForMessages,
                    directoryId,
                },
            });

            return { success: true, message };
        } catch (error) {
            const message = 'Failed to sync custom messages';
            this.logger.error({
                message,
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    configLevel,
                    repositoryId: repositoryIdForMessages,
                    directoryId,
                },
                error,
            });

            return { success: false, message };
        }
    }

    private async resolveCustomMessagesWithInheritance(
        organizationAndTeamData: OrganizationAndTeamData,
        configLevel: ConfigLevel,
        targetRepo: { id: string; name: string } | undefined,
        repositoryId: string | undefined,
        directoryId: string | undefined,
        directoryPath: string | undefined,
        customMessagesFromFile: DeepPartial<CustomMessageConfig>,
    ): Promise<CustomMessageConfig> {
        // Get the default custom messages
        const { customMessages: defaultMessages } = getDefaultKodusConfigFile();

        // Get existing parent configs to merge with
        const parentMessages = await this.getResolvedParentCustomMessages(
            organizationAndTeamData,
            configLevel,
            targetRepo,
            repositoryId,
            directoryId,
            directoryPath,
        );

        // Merge: default -> parent -> file overrides
        return this.mergeCustomMessages(
            defaultMessages,
            parentMessages,
            customMessagesFromFile,
        );
    }

    private async getResolvedParentCustomMessages(
        organizationAndTeamData: OrganizationAndTeamData,
        configLevel: ConfigLevel,
        targetRepo: { id: string; name: string } | undefined,
        repositoryId: string | undefined,
        directoryId: string | undefined,
        directoryPath: string | undefined,
    ): Promise<Partial<CustomMessageConfig>> {
        const globalEntity = await this.pullRequestMessagesService?.findOne({
            organizationId: organizationAndTeamData.organizationId,
            configLevel: ConfigLevel.GLOBAL,
        });
        const globalMessages =
            this.extractCustomMessagesFromEntity(globalEntity);

        if (configLevel === ConfigLevel.GLOBAL) {
            return globalMessages;
        }

        const repoEntity = await this.pullRequestMessagesService?.findOne({
            organizationId: organizationAndTeamData.organizationId,
            repositoryId,
            configLevel: ConfigLevel.REPOSITORY,
        });
        const repoMessages = this.extractCustomMessagesFromEntity(repoEntity);

        let mergedMessages = this.mergeCustomMessages(
            {},
            globalMessages,
            repoMessages,
        );

        if (configLevel === ConfigLevel.REPOSITORY) {
            return mergedMessages;
        }

        if (
            configLevel === ConfigLevel.DIRECTORY &&
            directoryPath &&
            targetRepo
        ) {
            // Trim slashes and split path
            const cleanPath = directoryPath.replace(/^\/+|\/+$/g, '');
            const segments = cleanPath.split('/');

            // Traverse parent directories sequentially
            let currentPath = '';
            for (let i = 0; i < segments.length - 1; i++) {
                currentPath = currentPath
                    ? `${currentPath}/${segments[i]}`
                    : segments[i];

                try {
                    const parentDirId =
                        await this.codeBaseConfigService.getDirectoryIdForPath(
                            organizationAndTeamData,
                            targetRepo,
                            currentPath,
                        );

                    if (parentDirId) {
                        const parentDirEntity =
                            await this.pullRequestMessagesService?.findOne({
                                organizationId:
                                    organizationAndTeamData.organizationId,
                                repositoryId,
                                directoryId: parentDirId,
                                configLevel: ConfigLevel.DIRECTORY,
                            });

                        if (parentDirEntity) {
                            const parentDirMessages =
                                this.extractCustomMessagesFromEntity(
                                    parentDirEntity,
                                );
                            mergedMessages = this.mergeCustomMessages(
                                mergedMessages,
                                parentDirMessages,
                            );
                        }
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Failed to resolve parent directory messages for path: ${currentPath}`,
                        context: CentralizedConfigService.name,
                        metadata: {
                            organizationAndTeamData,
                            repositoryId,
                            directoryPath,
                        },
                        error,
                    });
                }
            }
        }

        return mergedMessages;
    }

    private extractCustomMessagesFromEntity(
        entity: any,
    ): Partial<CustomMessageConfig> {
        if (!entity) {
            return {};
        }

        const json = entity.toJson ? entity.toJson() : entity;
        return {
            startReviewMessage: json?.startReviewMessage,
            endReviewMessage: json?.endReviewMessage,
            globalSettings: json?.globalSettings,
        };
    }

    private mergeCustomMessages(
        base: any,
        ...overrides: any[]
    ): CustomMessageConfig {
        const merged = { ...base };

        for (const override of overrides) {
            if (override.startReviewMessage) {
                merged.startReviewMessage = override.startReviewMessage;
            }
            if (override.endReviewMessage) {
                merged.endReviewMessage = override.endReviewMessage;
            }
            if (override.globalSettings) {
                merged.globalSettings = {
                    ...merged.globalSettings,
                    ...override.globalSettings,
                };
            }
        }

        let defaultConfigs: DeepPartial<CustomMessageConfig> | undefined;
        if (
            !merged.startReviewMessage ||
            !merged.endReviewMessage ||
            !merged.globalSettings?.hideComments ||
            !merged.globalSettings?.suggestionCopyPrompt
        ) {
            const defaultConfigFile = getDefaultKodusConfigFile();
            defaultConfigs = defaultConfigFile?.customMessages;

            if (!defaultConfigs) {
                this.logger.warn({
                    message:
                        'Default custom messages are missing from default config file',
                    context: CentralizedConfigService.name,
                });

                throw new Error(
                    'Default custom messages are missing from default config file',
                );
            }
        }

        // Ensure all required fields are present with defaults
        return {
            startReviewMessage:
                merged.startReviewMessage || defaultConfigs?.startReviewMessage,
            endReviewMessage:
                merged.endReviewMessage || defaultConfigs?.endReviewMessage,
            globalSettings: {
                hideComments:
                    merged.globalSettings?.hideComments ??
                    defaultConfigs?.globalSettings?.hideComments,
                suggestionCopyPrompt:
                    merged.globalSettings?.suggestionCopyPrompt ??
                    defaultConfigs?.globalSettings?.suggestionCopyPrompt,
            },
        };
    }

    private async removeStaleCustomMessages(
        configFiles: IConfigFileMeta[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        success: boolean;
        message: string;
    }> {
        try {
            const existingMessages =
                await this.pullRequestMessagesService?.find({
                    organizationId: organizationAndTeamData.organizationId,
                });

            if (!existingMessages || existingMessages.length === 0) {
                return {
                    success: true,
                    message: 'No existing custom messages to remove',
                };
            }

            const repositories =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    Repositories[]
                >(IntegrationConfigKey.REPOSITORIES, {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                });

            const desiredKeys = new Set<string>();

            const repositoriesMap = new Map(
                repositories?.map((repo) => [repo.id, repo]) ?? [],
            );

            for (const meta of configFiles) {
                if (!meta.repositoryId) {
                    desiredKeys.add(`GLOBAL`);
                } else if (!meta.directoryPath) {
                    desiredKeys.add(`REPO:${meta.repositoryId}`);
                } else {
                    const targetRepo = repositoriesMap.get(meta.repositoryId);

                    if (targetRepo?.name) {
                        try {
                            const directoryId =
                                await this.codeBaseConfigService.getDirectoryIdForPath(
                                    organizationAndTeamData,
                                    {
                                        id: targetRepo.id,
                                        name: targetRepo.name,
                                    },
                                    meta.directoryPath,
                                );

                            if (directoryId) {
                                desiredKeys.add(`DIR:${directoryId}`);
                            }
                        } catch (error) {
                            this.logger.warn({
                                message: `Failed to resolve directory ID for stale message cleanup for path: ${meta.directoryPath}`,
                                context: CentralizedConfigService.name,
                                metadata: {
                                    organizationAndTeamData,
                                    repositoryId: meta.repositoryId,
                                    directoryPath: meta.directoryPath,
                                },
                                error,
                            });
                        }
                    }
                }
            }

            // 3. Compare and delete stale entities
            for (const message of existingMessages) {
                let key: string | undefined;

                if (message.configLevel === ConfigLevel.GLOBAL) {
                    key = 'GLOBAL';
                } else if (
                    message.configLevel === ConfigLevel.REPOSITORY &&
                    message.repositoryId
                ) {
                    key = `REPO:${message.repositoryId}`;
                } else if (
                    message.configLevel === ConfigLevel.DIRECTORY &&
                    message.directoryId
                ) {
                    key = `DIR:${message.directoryId}`;
                }

                if (key && !desiredKeys.has(key)) {
                    // Extract the UUID from the entity
                    const entityUuid = message.uuid;

                    if (!entityUuid) {
                        this.logger.warn({
                            message:
                                'Cannot delete stale message: missing uuid on entity',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                configLevel: message.configLevel,
                                repositoryId: message.repositoryId,
                            },
                        });
                        continue;
                    }

                    this.logger.log({
                        message: 'Removing stale custom message configuration',
                        context: CentralizedConfigService.name,
                        metadata: {
                            organizationAndTeamData,
                            configLevel: message.configLevel,
                            repositoryId: message.repositoryId,
                            directoryId: message.directoryId,
                            entityUuid,
                        },
                    });

                    // Execute deletion using only the uuid
                    await this.pullRequestMessagesService.delete(entityUuid);
                }
            }

            const message = 'Stale custom messages removed successfully';
            this.logger.log({
                message,
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    configFilesCount: configFiles.length,
                },
            });

            return {
                success: true,
                message,
            };
        } catch (error) {
            const message = 'Error removing stale custom messages';
            this.logger.error({
                message,
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    configFilesCount: configFiles.length,
                },
                error,
            });

            return {
                success: false,
                message,
            };
        }
    }
    //#endregion

    //#region Kody Rules Sync Helpers
    async discoverKodyRulesFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<IKodyRuleFileMeta[]> {
        const { organizationAndTeamData, repository } = params;

        const ruleFilePaths = await this.scanRepositoryTree<IKodyRuleFileMeta>(
            organizationAndTeamData,
            repository,
            (item, resolvedRepoIds) => {
                const fileName = path.basename(item.path);
                const fileExt = path.extname(fileName).toLowerCase();

                if (!['.yml', '.yaml'].includes(fileExt)) return null;

                const dirName = path.dirname(item.path);

                let ruleType: KodyRulesType;
                if (dirName.includes('.kody-rules/memories')) {
                    ruleType = KodyRulesType.MEMORY;
                } else if (dirName.includes('.kody-rules/review')) {
                    ruleType = KodyRulesType.STANDARD;
                } else {
                    if (dirName.includes('.kody-rules')) {
                        this.logger.warn({
                            message:
                                'Skipping YAML under .kody-rules/ that is not inside review/ or memories/. Move the file into review/ for code review rules or memories/ for memories.',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                filePath: item.path,
                            },
                        });
                    }
                    return null;
                }

                const pathSegments = dirName.split('/');
                const kodyRulesIndex = pathSegments.indexOf('.kody-rules');

                if (
                    kodyRulesIndex === -1 ||
                    pathSegments.length < kodyRulesIndex + 2
                ) {
                    return null;
                }

                let repositoryId: string | undefined;
                let directoryPath: string | undefined;
                let directoryPaths: string[] | undefined;
                let centralizedDirectoryPath: string;
                const rulesSubdir =
                    ruleType === KodyRulesType.MEMORY ? 'memories' : 'review';

                if (kodyRulesIndex === 0) {
                    // Global rules
                    centralizedDirectoryPath = `.kody-rules/${rulesSubdir}`;
                } else {
                    // Repository/Directory-group rules
                    const repoName = pathSegments[0];
                    repositoryId = resolvedRepoIds.get(repoName.toLowerCase());

                    if (!repositoryId) {
                        this.logger.warn({
                            message: `Could not resolve repository ID for repository name: ${repoName}`,
                            context: CentralizedConfigService.name,
                            metadata: { organizationAndTeamData, repoName },
                        });
                        return null;
                    }

                    const directorySegments = pathSegments.slice(
                        1,
                        kodyRulesIndex,
                    );

                    if (directorySegments.length === 0) {
                        centralizedDirectoryPath = `${repoName}/.kody-rules/${rulesSubdir}`;
                    } else if (directorySegments.length === 1) {
                        const decoded = parseGroupFolderName(
                            directorySegments[0],
                        );
                        if (!decoded) {
                            this.logger.warn({
                                message:
                                    'Skipping Kody rule — group folder is not a valid path encoding',
                                context: CentralizedConfigService.name,
                                metadata: {
                                    organizationAndTeamData,
                                    repoName,
                                    folder: directorySegments[0],
                                },
                            });
                            return null;
                        }

                        directoryPaths = decoded.map((p) =>
                            p.startsWith('/') ? p : `/${p}`,
                        );
                        directoryPath = directoryPaths[0];
                        centralizedDirectoryPath = `${repoName}/${directorySegments[0]}/.kody-rules/${rulesSubdir}`;
                    } else {
                        this.logger.warn({
                            message:
                                'Skipping Kody rule at unsupported nested path',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                repoName,
                                path: dirName,
                            },
                        });
                        return null;
                    }
                }

                return {
                    centralizedDirectoryPath,
                    repositoryId,
                    directoryPath,
                    directoryPaths,
                    ruleType,
                    ruleFilePath: item.path,
                    path: item.path,
                };
            },
        );

        return this.sortKodyRuleFiles(ruleFilePaths);
    }

    private sortKodyRuleFiles(
        ruleFiles: IKodyRuleFileMeta[],
    ): IKodyRuleFileMeta[] {
        const getPriority = (ruleFile: IKodyRuleFileMeta) => {
            if (!ruleFile.repositoryId) {
                return 0; // Global
            }

            if (!ruleFile.directoryPath) {
                return 1; // Repository
            }

            return 2; // Directory
        };

        return [...ruleFiles].sort((a, b) => {
            const priorityA = getPriority(a);
            const priorityB = getPriority(b);

            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }

            // For same priority, sort by directory depth
            const depthA =
                a.directoryPath?.split('/').filter(Boolean).length ?? 0;
            const depthB =
                b.directoryPath?.split('/').filter(Boolean).length ?? 0;

            return depthA - depthB;
        });
    }

    async fetchKodyRuleFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        filePath: string;
    }): Promise<DeepPartial<IKodyRule> | null> {
        const { organizationAndTeamData, repository, filePath } = params;

        try {
            const defaultBranch =
                await this.codeManagementService.getDefaultBranch({
                    organizationAndTeamData,
                    repository,
                });

            const response =
                await this.codeManagementService.getRepositoryContentFile({
                    organizationAndTeamData,
                    repository,
                    file: { filename: filePath },
                    pullRequest: {
                        head: { ref: defaultBranch },
                        base: { ref: defaultBranch },
                    },
                });

            if (!response || !response.data || !response.data.content) {
                return null;
            }

            let content = response.data.content;

            if (response.data.encoding === 'base64') {
                content = Buffer.from(content, 'base64').toString('utf-8');
            }

            const parsedRule = yaml.load(content);

            return parsedRule;
        } catch (error) {
            this.logger.error({
                message:
                    'Error fetching centralized Kody rule file from repository',
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    filePath,
                },
                error,
            });

            return null;
        }
    }

    async synchronizeKodyRules(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        ruleFiles: IKodyRuleFileMeta[];
        actor: {
            organizationId: string;
            source: 'web' | 'sync' | 'cli';
            userEmail: string;
            userId: string;
        };
    }): Promise<{
        success: boolean;
        message: string;
        syncedRuleCount?: number;
        failureDetails?: Array<{ file: string; error: string }>;
    }> {
        const { organizationAndTeamData, ruleFiles, actor } = params;

        try {
            const centralizedRepository =
                await this.getCentralizedConfigRepository(
                    organizationAndTeamData,
                );

            let syncedCount = 0;
            const failureDetails: Array<{ file: string; error: string }> = [];

            const repositories =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    Repositories[]
                >(IntegrationConfigKey.REPOSITORIES, {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                });

            const repositoriesMap = new Map<
                string,
                { id: string; name: string }
            >();

            repositories?.forEach((repo) => {
                if (repo.id && repo.name) {
                    repositoriesMap.set(repo.id, {
                        id: repo.id,
                        name: repo.name,
                    });
                }
            });

            const directoryIdCache = new Map<string, string>();

            const existingRulesEntity =
                await this.kodyRulesService.findByOrganizationId(
                    organizationAndTeamData.organizationId,
                );

            const getSourcePathLookupKey = (sourcePath?: string) =>
                (sourcePath || '').split('#')[0];

            const existingRuleBySourcePath = new Map<
                string,
                { uuid: string; status?: KodyRulesStatus; updatedAt?: Date }
            >();

            for (const existingRule of existingRulesEntity?.rules || []) {
                const sourcePathKey = getSourcePathLookupKey(
                    existingRule.centralizedConfig?.path,
                );

                if (!sourcePathKey || !existingRule.uuid) {
                    continue;
                }

                const currentMapped =
                    existingRuleBySourcePath.get(sourcePathKey);

                if (!currentMapped) {
                    existingRuleBySourcePath.set(sourcePathKey, {
                        uuid: existingRule.uuid,
                        status: existingRule.status,
                        updatedAt: existingRule.updatedAt,
                    });
                    continue;
                }

                const currentIsDeleted =
                    currentMapped.status === KodyRulesStatus.DELETED;
                const nextIsDeleted =
                    existingRule.status === KodyRulesStatus.DELETED;

                // Prefer non-deleted rules for the same source path to avoid creating duplicates.
                if (currentIsDeleted && !nextIsDeleted) {
                    existingRuleBySourcePath.set(sourcePathKey, {
                        uuid: existingRule.uuid,
                        status: existingRule.status,
                        updatedAt: existingRule.updatedAt,
                    });
                    continue;
                }

                const currentUpdatedAt =
                    currentMapped.updatedAt instanceof Date
                        ? currentMapped.updatedAt.getTime()
                        : new Date(currentMapped.updatedAt || 0).getTime();
                const nextUpdatedAt =
                    existingRule.updatedAt instanceof Date
                        ? existingRule.updatedAt.getTime()
                        : new Date(existingRule.updatedAt || 0).getTime();

                if (nextUpdatedAt > currentUpdatedAt) {
                    existingRuleBySourcePath.set(sourcePathKey, {
                        uuid: existingRule.uuid,
                        status: existingRule.status,
                        updatedAt: existingRule.updatedAt,
                    });
                }
            }

            for (const ruleFileMeta of ruleFiles) {
                try {
                    const ruleContent = await this.fetchKodyRuleFile({
                        organizationAndTeamData,
                        repository: centralizedRepository,
                        filePath: ruleFileMeta.ruleFilePath,
                    });

                    if (!ruleContent) {
                        failureDetails.push({
                            file: ruleFileMeta.ruleFilePath,
                            error: 'Could not fetch or parse rule file',
                        });
                        continue;
                    }

                    if (!ruleContent.title || !ruleContent.rule) {
                        failureDetails.push({
                            file: ruleFileMeta.ruleFilePath,
                            error: 'Missing required fields: title and/or rule',
                        });
                        continue;
                    }

                    let directoryId: string | undefined;

                    // Repo-first: when the rule lives under an encoded group
                    // folder (multiple paths), ensure the corresponding group
                    // exists in DB with the exact path set before resolving
                    // its id. This is what creates groups for rule-only
                    // folders (no kodus-config.yml at the group level).
                    if (
                        ruleFileMeta.directoryPaths &&
                        ruleFileMeta.directoryPaths.length > 0 &&
                        ruleFileMeta.repositoryId
                    ) {
                        try {
                            await this.updateOrCreateCodeReviewParameterUseCase.execute(
                                {
                                    actor,
                                    skipAuthorization: true,
                                    configValue: {},
                                    organizationAndTeamData,
                                    repositoryId: ruleFileMeta.repositoryId,
                                    directoryPaths:
                                        ruleFileMeta.directoryPaths,
                                } as any,
                            );

                            directoryId =
                                await this.resolveGroupIdByExactPaths(
                                    organizationAndTeamData,
                                    ruleFileMeta.repositoryId,
                                    ruleFileMeta.directoryPaths,
                                );
                        } catch (error) {
                            this.logger.warn({
                                message:
                                    'Failed to ensure directory group exists for rule; falling back to single-path lookup',
                                context: CentralizedConfigService.name,
                                metadata: {
                                    organizationAndTeamData,
                                    repositoryId: ruleFileMeta.repositoryId,
                                    directoryPaths:
                                        ruleFileMeta.directoryPaths,
                                    filePath: ruleFileMeta.ruleFilePath,
                                },
                                error,
                            });
                        }
                    }

                    if (
                        !directoryId &&
                        ruleFileMeta.directoryPath &&
                        ruleFileMeta.repositoryId
                    ) {
                        const targetRepo = repositoriesMap.get(
                            ruleFileMeta.repositoryId,
                        );

                        if (targetRepo?.name) {
                            directoryId = directoryIdCache.get(
                                ruleFileMeta.directoryPath,
                            );

                            if (!directoryId) {
                                try {
                                    directoryId =
                                        await this.codeBaseConfigService.getDirectoryIdForPath(
                                            organizationAndTeamData,
                                            {
                                                id: targetRepo.id,
                                                name: targetRepo.name,
                                            },
                                            ruleFileMeta.directoryPath,
                                        );

                                    if (directoryId) {
                                        directoryIdCache.set(
                                            ruleFileMeta.directoryPath,
                                            directoryId,
                                        );
                                    }
                                } catch (error) {
                                    this.logger.warn({
                                        message:
                                            'Could not resolve directory ID for rule',
                                        context: CentralizedConfigService.name,
                                        metadata: {
                                            organizationAndTeamData,
                                            repositoryId:
                                                ruleFileMeta.repositoryId,
                                            directoryPath:
                                                ruleFileMeta.directoryPath,
                                            filePath: ruleFileMeta.ruleFilePath,
                                        },
                                        error,
                                    });
                                }
                            }
                        }
                    }

                    const compliantRule =
                        this.ensureKodyRuleCompliance(ruleContent);

                    if (!compliantRule) {
                        failureDetails.push({
                            file: ruleFileMeta.ruleFilePath,
                            error: 'Rule file does not comply with required schema',
                        });
                        continue;
                    }

                    const ruleDto = {
                        ...compliantRule,
                        uuid: existingRuleBySourcePath.get(
                            getSourcePathLookupKey(ruleFileMeta.path),
                        )?.uuid,
                        type: ruleFileMeta.ruleType,
                        status: KodyRulesStatus.ACTIVE,
                        repositoryId: ruleFileMeta.repositoryId || 'global',
                        directoryId,
                        centralizedConfig: {
                            path: ruleFileMeta.path,
                            status: KodyRuleCentralizedStatus.SYNCED,
                        },
                        origin: KodyRulesOrigin.USER,
                    };

                    await this.createOrUpdateKodyRulesUseCase.execute(
                        ruleDto,
                        organizationAndTeamData.organizationId,
                        actor,
                        true,
                    );

                    syncedCount++;
                } catch (error) {
                    failureDetails.push({
                        file: ruleFileMeta.ruleFilePath,
                        error:
                            error instanceof Error
                                ? error.message
                                : 'Unknown error',
                    });

                    this.logger.error({
                        message: 'Error syncing individual Kody rule file',
                        context: CentralizedConfigService.name,
                        metadata: {
                            organizationAndTeamData,
                            filePath: ruleFileMeta.ruleFilePath,
                        },
                        error,
                    });
                }
            }

            const message = `Kody rules synchronized successfully. Synced: ${syncedCount}, Failed: ${failureDetails.length}`;

            if (failureDetails.length > 0) {
                this.logger.warn({
                    message,
                    context: CentralizedConfigService.name,
                    metadata: {
                        organizationAndTeamData,
                        syncedCount,
                        failureCount: failureDetails.length,
                        failureDetails,
                    },
                });
            } else {
                this.logger.log({
                    message,
                    context: CentralizedConfigService.name,
                    metadata: {
                        organizationAndTeamData,
                        syncedCount,
                    },
                });
            }

            return {
                success: true,
                message,
                syncedRuleCount: syncedCount,
                failureDetails:
                    failureDetails.length > 0 ? failureDetails : undefined,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error synchronizing Kody rules',
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    ruleFilesCount: ruleFiles.length,
                },
                error,
            });

            return {
                success: false,
                message: 'Error synchronizing Kody rules',
                failureDetails: [
                    {
                        file: 'general',
                        error:
                            error instanceof Error
                                ? error.message
                                : 'Unknown error',
                    },
                ],
            };
        }
    }

    private ensureKodyRuleCompliance(ruleContent: any) {
        const result = kodyRuleSchema
            .pick({
                title: true,
                rule: true,
                severity: true,
                examples: true,
                inheritance: true,
                scope: true,
                path: true,
            })
            .extend({
                severity: z
                    .enum(KodyRuleSeverity)
                    .default(KodyRuleSeverity.MEDIUM),
                examples: z.array(kodyRulesExampleSchema).default([]),
                path: z.string().default('**/*'),
                scope: z.enum(KodyRulesScope).default(KodyRulesScope.FILE),
                inheritance: kodyRulesInheritanceSchema.default({
                    inheritable: true,
                    include: [],
                    exclude: [],
                }),
            })
            .safeParse(ruleContent);

        return result.success ? result.data : null;
    }

    async removeStaleKodyRules(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        ruleFiles: IKodyRuleFileMeta[];
        actor: {
            organizationId: string;
            source: 'sync' | 'web' | 'cli';
            userEmail: string;
            userId: string;
        };
    }): Promise<{
        success: boolean;
        message: string;
        removedRuleCount?: number;
    }> {
        const { organizationAndTeamData, ruleFiles, actor } = params;

        try {
            const existingEntity =
                await this.kodyRulesService.findByOrganizationId(
                    organizationAndTeamData.organizationId,
                );

            if (!existingEntity) {
                return {
                    success: true,
                    message: 'No existing Kody rules to check for staleness',
                };
            }

            const currentSourcePaths = new Set(
                ruleFiles.map((meta) => meta.path),
            );

            let removedCount = 0;

            const existingRules = existingEntity?.toJson?.()?.rules || [];

            for (const rule of existingRules) {
                const sourcePath = rule.centralizedConfig?.path;

                if (!currentSourcePaths.has(sourcePath)) {
                    try {
                        await this.deleteRuleInOrganizationByIdKodyRulesUseCase.execute(
                            rule.uuid,
                            actor,
                        );

                        removedCount++;

                        this.logger.log({
                            message:
                                'Marked stale centralized Kody rule as deleted',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                ruleId: rule.uuid,
                                sourcePath,
                                title: rule.title,
                            },
                        });
                    } catch (error) {
                        this.logger.error({
                            message: 'Error marking stale Kody rule as deleted',
                            context: CentralizedConfigService.name,
                            metadata: {
                                organizationAndTeamData,
                                ruleId: rule.uuid,
                                sourcePath,
                            },
                            error,
                        });
                    }
                }
            }

            const message =
                removedCount > 0
                    ? `Removed ${removedCount} stale Kody rules`
                    : 'No stale Kody rules to remove';

            this.logger.log({
                message,
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    removedCount,
                },
            });

            return {
                success: true,
                message,
                removedRuleCount: removedCount,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error removing stale Kody rules',
                context: CentralizedConfigService.name,
                metadata: {
                    organizationAndTeamData,
                    ruleFilesCount: ruleFiles.length,
                },
                error,
            });

            return {
                success: false,
                message: 'Error removing stale Kody rules',
            };
        }
    }

    //#region Helpers
    async scanRepositoryTree<T>(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        matcher: (
            item: TreeItem,
            resolvedRepoIds: Map<string, string>,
        ) => T | null,
    ): Promise<T[]> {
        const repoTree = await this.codeManagementService.getRepositoryTree({
            organizationAndTeamData,
            repositoryId: repository.id,
        });
        const repositories =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            });

        if (!repositories || !Array.isArray(repositories)) {
            this.logger.warn({
                message:
                    'No repositories found in integration config during tree scan',
                context: CentralizedConfigService.name,
                metadata: { organizationAndTeamData },
            });
            return [];
        }

        const resolvedRepoIds = new Map(
            repositories.flatMap((repo) =>
                [
                    [repo.name?.toLowerCase(), repo.id] as const,
                    [repo.full_name?.toLowerCase(), repo.id] as const,
                ].filter(Boolean),
            ),
        );

        const results: T[] = [];
        for (const item of repoTree) {
            if (item.type === 'directory') continue;
            const matched = matcher(item, resolvedRepoIds);
            if (matched) results.push(matched);
        }
        return results;
    }
}
