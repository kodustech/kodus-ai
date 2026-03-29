import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import path from 'path';
import { DeleteRepositoryCodeReviewParameterUseCase } from './delete-repository-code-review-parameter.use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from './update-or-create-code-review-parameter-use-case';

type ConfigFileMeta = {
    centralizedDirectoryPath?: string;
    repositoryId?: string;
    directoryPath?: string;
};

@Injectable()
export class CentralizedConfigSyncUseCase {
    private readonly logger = new Logger(CentralizedConfigSyncUseCase.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly codeManagementService: CodeManagementService,
        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,
        private readonly deleteRepositoryCodeReviewParameterUseCase: DeleteRepositoryCodeReviewParameterUseCase,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { name: string; id: string };
    }): Promise<{
        success: boolean;
        message: string;
    }> {
        const { organizationAndTeamData } = params;

        try {
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
                        context: CentralizedConfigSyncUseCase.name,
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
                    context: CentralizedConfigSyncUseCase.name,
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

            this.logger.log({
                message: 'Starting centralized config sync',
                context: CentralizedConfigSyncUseCase.name,
                metadata: {
                    organizationAndTeamData,
                },
            });

            const actor = {
                organizationId: organizationAndTeamData.organizationId,
                source: 'sync' as const,
                userEmail: 'kody@kodus.io',
                userId: 'kody',
            };

            const configFilesMeta = await this.getConfigFilePaths({
                organizationAndTeamData,
                repository,
            });

            const codeReviewConfig = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            const hasGlobalConfigFile = configFilesMeta.some(
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

            const sortedConfigFilesMeta = this.sortConfigFiles(configFilesMeta);

            for (const configFileMeta of sortedConfigFilesMeta) {
                const {
                    centralizedDirectoryPath,
                    repositoryId,
                    directoryPath,
                } = configFileMeta;

                const configFile = await this.getConfigFile({
                    organizationAndTeamData,
                    repository,
                    dir: centralizedDirectoryPath,
                });

                if (!configFile) {
                    this.logger.warn({
                        message:
                            'Config file not found or could not be fetched',
                        context: CentralizedConfigSyncUseCase.name,
                        metadata: {
                            organizationAndTeamData,
                            repository,
                            centralizedDirectoryPath,
                            repositoryId,
                            directoryPath,
                        },
                    });
                    continue;
                }

                await this.updateOrCreateCodeReviewParameterUseCase.execute({
                    actor,
                    skipAuthorization: true,
                    configValue: configFile,
                    organizationAndTeamData,
                    repositoryId,
                    directoryPath,
                });
            }

            await this.removeStaleConfigs({
                organizationAndTeamData,
                configFilesMeta,
            });

            return {
                success: true,
                message: 'Centralized config sync completed successfully',
            };
        } catch (error) {
            this.logger.error({
                message: 'Error syncing centralized config',
                context: CentralizedConfigSyncUseCase.name,
                metadata: {
                    organizationAndTeamData,
                },
                error,
            });

            return {
                success: false,
                message: 'Error syncing centralized config',
            };
        }
    }

    private async getConfigFilePaths(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<ConfigFileMeta[]> {
        const { organizationAndTeamData, repository } = params;

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
                message: 'No repositories found in integration config',
                context: CentralizedConfigSyncUseCase.name,
                metadata: {
                    organizationAndTeamData,
                },
            });
            return [];
        }

        const resolvedRepoIds = new Map<string, string>();
        for (const repo of repositories) {
            if (repo.name) {
                resolvedRepoIds.set(repo.name.toLowerCase(), repo.id);
            }

            if (repo.full_name) {
                resolvedRepoIds.set(repo.full_name.toLowerCase(), repo.id);
            }
        }

        const configFilePaths: ConfigFileMeta[] = [];

        for (const item of repoTree) {
            if (item.type === 'directory') {
                continue;
            }

            const fileName = path.basename(item.path);

            if (fileName !== 'kodus-config.yml') {
                continue;
            }

            const dirName = path.dirname(item.path);
            if (dirName === '.') {
                configFilePaths.push({});
                continue;
            }

            const directorySegments = dirName.split('/');
            const repoName = directorySegments[0];

            const repoId = resolvedRepoIds.get(repoName.toLowerCase());
            if (!repoId) {
                this.logger.warn({
                    message: `Could not resolve repository ID for repository name: ${repoName}`,
                    context: CentralizedConfigSyncUseCase.name,
                    metadata: {
                        organizationAndTeamData,
                        repoName,
                    },
                });
                continue;
            }

            const relativeDirectoryPath = directorySegments.slice(1).join('/');

            configFilePaths.push({
                repositoryId: repoId,
                centralizedDirectoryPath: dirName,
                directoryPath: relativeDirectoryPath
                    ? `/${relativeDirectoryPath}`
                    : undefined,
            });
        }

        return configFilePaths;
    }

    private sortConfigFiles(configFiles: ConfigFileMeta[]): ConfigFileMeta[] {
        const getPriority = (configFile: ConfigFileMeta) => {
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

    private async removeStaleConfigs(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        configFilesMeta: ConfigFileMeta[];
    }) {
        const { organizationAndTeamData, configFilesMeta } = params;

        const actor = {
            source: 'sync' as const,
            organizationId: organizationAndTeamData.organizationId,
            userId: 'kody',
            userEmail: 'kody@kodus.io',
        };

        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        if (!codeReviewConfig?.configValue) {
            return;
        }

        const desiredHasGlobalConfig = configFilesMeta.some(
            (meta) => !meta.repositoryId,
        );

        const desiredRepositoryConfigs = new Set<string>(
            configFilesMeta
                .filter((meta) => meta.repositoryId && !meta.directoryPath)
                .map((meta) => meta.repositoryId as string),
        );

        const desiredDirectoryConfigsByRepository = new Map<
            string,
            Set<string>
        >();

        const repositoriesWithDeletedDirectories = new Set<string>();

        for (const meta of configFilesMeta) {
            if (!meta.repositoryId || !meta.directoryPath) {
                continue;
            }

            if (!desiredDirectoryConfigsByRepository.has(meta.repositoryId)) {
                desiredDirectoryConfigsByRepository.set(
                    meta.repositoryId,
                    new Set<string>(),
                );
            }

            desiredDirectoryConfigsByRepository
                .get(meta.repositoryId)
                ?.add(meta.directoryPath);
        }

        // Reuse existing deletion logic for directory scope removals.
        for (const repository of codeReviewConfig.configValue.repositories ??
            []) {
            const desiredDirectoryPaths =
                desiredDirectoryConfigsByRepository.get(repository.id) ??
                new Set<string>();

            const staleDirectories = (repository.directories ?? []).filter(
                (directory) => !desiredDirectoryPaths.has(directory.path),
            );

            for (const staleDirectory of staleDirectories) {
                await this.deleteRepositoryCodeReviewParameterUseCase.execute({
                    teamId: organizationAndTeamData.teamId,
                    repositoryId: repository.id,
                    directoryId: staleDirectory.id,
                    organizationAndTeamData,
                    actor,
                });

                repositoriesWithDeletedDirectories.add(repository.id);
            }
        }

        let refreshedCodeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        if (!refreshedCodeReviewConfig?.configValue) {
            return;
        }

        for (const repository of refreshedCodeReviewConfig.configValue
            .repositories ?? []) {
            const shouldKeepRepositoryConfig = desiredRepositoryConfigs.has(
                repository.id,
            );

            if (shouldKeepRepositoryConfig) {
                continue;
            }

            const hasDirectories = (repository.directories ?? []).length > 0;
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
            return;
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
                const shouldKeepRepositoryConfig = desiredRepositoryConfigs.has(
                    repository.id,
                );

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
            (!desiredHasGlobalConfig ||
                JSON.stringify(reconciledConfig.configs) !==
                    JSON.stringify(
                        refreshedCodeReviewConfig.configValue.configs,
                    ))
        ) {
            hasChanges = true;
        }

        if (!hasChanges) {
            return;
        }

        await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CODE_REVIEW_CONFIG,
            reconciledConfig,
            organizationAndTeamData,
        );
    }

    private async getConfigFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        dir?: string;
    }) {
        const { organizationAndTeamData, repository, dir } = params;

        try {
            const file = await this.codeBaseConfigService.getKodusConfigFile({
                organizationAndTeamData,
                repository,
                defaultBranch: 'main',
                directoryPath: dir,
                removeProperties: false,
            });

            return file;
        } catch (error) {
            this.logger.error({
                message:
                    'Error fetching centralized config file from repository',
                context: CentralizedConfigSyncUseCase.name,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    dir,
                },
                error,
            });

            return null;
        }
    }
}
