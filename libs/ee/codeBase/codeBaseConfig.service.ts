import { createLogger } from '@kodus/flow';
import { forwardRef, Inject, Injectable } from '@nestjs/common';

import { LanguageValue } from '@libs/core/domain/enums/language-parameter.enum';

import { ICodeBaseConfigService } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import globalIgnorePathsJson from '@libs/common/utils/codeBase/ignorePaths/generated/paths.json';
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import {
    CodeReviewConfig,
    CodeReviewConfigWithoutLLMProvider,
    FileChange,
    KodusConfigFile,
    KodyFineTuningConfig,
    ReviewModeConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    CodeReviewParameter,
    DirectoryCodeReviewConfig,
    RepositoryCodeReviewConfig,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import * as yaml from 'js-yaml';

import { decrypt } from '@libs/common/utils/crypto';
import { ValidateCodeManagementIntegration } from '@libs/common/utils/decorators/validate-code-management-integration.decorator';
import { deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { CacheService } from '@libs/core/cache/cache.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    GLOBAL_PARAMETERS_SERVICE_TOKEN,
    IGlobalParametersService,
} from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { KodyRulesValidationService } from '../kodyRules/service/kody-rules-validation.service';

const GLOBAL_IGNORE_PATHS_CACHE_KEY = 'global:ignore_paths';
const GLOBAL_IGNORE_PATHS_CACHE_TTL = 43200000; // 12 hours

const IP_E2B_CACHE_KEY = 'global:ip_e2b';
const IP_E2B_CACHE_TTL = 604800000; // 1 week

@Injectable()
export default class CodeBaseConfigService implements ICodeBaseConfigService {
    private readonly logger = createLogger(CodeBaseConfigService.name);
    private readonly DEFAULT_CONFIG: CodeReviewConfig;

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(forwardRef(() => KODY_RULES_SERVICE_TOKEN))
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParametersService: IGlobalParametersService,
        private readonly codeManagementService: CodeManagementService,
        private readonly kodyRulesValidationService: KodyRulesValidationService,
        private readonly permissionValidationService: PermissionValidationService,
        private readonly cacheService: CacheService,
    ) {
        this.DEFAULT_CONFIG = this.getDefaultConfigs();
    }

    @ValidateCodeManagementIntegration()
    async getConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        preliminaryFiles?: FileChange[],
    ): Promise<CodeReviewConfig> {
        try {
            const [
                parameters,
                language,
                defaultBranch,
                kodyRulesEntity,
                reviewModeConfig,
                kodyFineTuningConfig,
            ] = await Promise.all([
                this.parametersService.findOne({
                    configKey: ParametersKey.CODE_REVIEW_CONFIG,
                    team: { uuid: organizationAndTeamData.teamId },
                    active: true,
                }),
                this.parametersService.findByKey(
                    ParametersKey.LANGUAGE_CONFIG,
                    organizationAndTeamData,
                ),
                this.getDefaultBranch(organizationAndTeamData, repository),
                this.kodyRulesService.findByOrganizationId(
                    organizationAndTeamData.organizationId,
                ),
                this.getReviewModeConfigParameter(organizationAndTeamData),
                this.getKodyFineTuningConfigParameter(organizationAndTeamData),
            ]);

            const mergedConfigs = await this.getMergedCodeReviewConfigs(
                organizationAndTeamData,
                repository,
                parameters?.configValue,
                defaultBranch,
                preliminaryFiles || [],
            );

            const limited =
                await this.permissionValidationService.shouldLimitResources(
                    organizationAndTeamData,
                    CodeBaseConfigService.name,
                );

            const { standardRules, memoryRules } =
                this.kodyRulesValidationService.filterKodyRules(
                    kodyRulesEntity?.toObject()?.rules || [],
                    repository.id,
                    mergedConfigs.directoryId,
                    limited,
                ) || { standardRules: [], memoryRules: [] };

            const globalIgnorePaths = await this.getGlobalIgnorePaths(
                organizationAndTeamData,
            );

            const fullConfig = {
                ...mergedConfigs,
                languageResultPrompt:
                    language?.configValue ??
                    this.DEFAULT_CONFIG.languageResultPrompt,
                baseBranchDefault: defaultBranch,
                kodyRules: standardRules,
                kodyMemoryRules: memoryRules,
                reviewModeConfig,
                kodyFineTuningConfig,
                ignorePaths:
                    mergedConfigs.ignorePaths.concat(globalIgnorePaths),
                // v2-only prompt overrides (categories and severity guidance). Read from repo/global parameters.
                v2PromptOverrides: this.sanitizeV2PromptOverrides(
                    mergedConfigs.v2PromptOverrides,
                ),
            };

            return fullConfig;
        } catch (error) {
            this.logger.error({
                message: 'Error getting code review config parameters',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData },
            });
            throw new Error('Error getting code review config parameters', {
                cause: error,
            });
        }
    }

    async getSimpleConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        params: {
            repositoryId?: string;
            directoryId?: string;
            preliminaryFiles?: FileChange[];
        },
    ): Promise<CodeReviewConfigWithoutLLMProvider> {
        try {
            const parameter = await this.parametersService.findOne({
                configKey: ParametersKey.CODE_REVIEW_CONFIG,
                team: { uuid: organizationAndTeamData.teamId },
                active: true,
            });

            if (!parameter?.configValue) {
                return this.DEFAULT_CONFIG;
            }

            const globalDelta = parameter.configValue?.configs;

            const repoConfig = params.repositoryId
                ? parameter.configValue?.repositories?.find(
                      (repo) => repo.id === params.repositoryId,
                  )
                : undefined;

            const repoDelta = repoConfig?.configs;

            const directoryConfig = params.directoryId
                ? repoConfig?.directories?.find(
                      (directory) => directory.id === params.directoryId,
                  )
                : repoConfig
                  ? this.resolveConfigByDirectories(
                        organizationAndTeamData,
                        repoConfig,
                        this.extractUniqueDirectoryPaths(
                            params.preliminaryFiles || [],
                        ),
                    )
                  : undefined;

            const directoryDelta = directoryConfig?.configs;

            const merged = deepMerge(
                this.DEFAULT_CONFIG,
                globalDelta || {},
                repoDelta || {},
                directoryDelta || {},
            );

            let configLevel = ConfigLevel.GLOBAL;
            let directoryId: string | undefined = undefined;
            let directoryPath: string | undefined = undefined;

            if (directoryDelta) {
                configLevel = ConfigLevel.DIRECTORY;
                directoryId = directoryConfig?.id;
                directoryPath = this.getDirectoryPrimaryPath(directoryConfig);
            } else if (repoDelta) {
                configLevel = ConfigLevel.REPOSITORY;
            }

            return {
                ...merged,
                configLevel,
                directoryId,
                directoryPath,
                directoryFolders: this.getDirectoryFolders(directoryConfig),
                v2PromptOverrides: this.sanitizeV2PromptOverrides(
                    merged.v2PromptOverrides,
                ),
            } as CodeReviewConfigWithoutLLMProvider;
        } catch (error) {
            this.logger.error({
                message: 'Error getting simple code review config parameters',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData, params },
            });
            throw new Error(
                'Error getting simple code review config parameters',
                { cause: error },
            );
        }
    }

    private sanitizeV2PromptOverrides(
        overrides: CodeReviewConfig['v2PromptOverrides'],
    ): CodeReviewConfig['v2PromptOverrides'] {
        if (!overrides) return undefined;

        const sanitizeString = (value: any): string | undefined => {
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
            return undefined;
        };

        const categories = overrides.categories?.descriptions
            ? {
                  descriptions: {
                      bug: sanitizeString(
                          overrides.categories.descriptions.bug,
                      ),
                      performance: sanitizeString(
                          overrides.categories.descriptions.performance,
                      ),
                      security: sanitizeString(
                          overrides.categories.descriptions.security,
                      ),
                  },
              }
            : undefined;

        const severity = overrides.severity?.flags
            ? {
                  flags: {
                      critical: sanitizeString(
                          overrides.severity.flags.critical,
                      ),
                      high: sanitizeString(overrides.severity.flags.high),
                      medium: sanitizeString(overrides.severity.flags.medium),
                      low: sanitizeString(overrides.severity.flags.low),
                  },
              }
            : undefined;

        const generation = overrides.generation
            ? {
                  main: sanitizeString(overrides.generation.main),
              }
            : undefined;

        return {
            categories,
            severity,
            generation,
        };
    }

    async getMergedCodeReviewConfigs(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        parameter: CodeReviewParameter,
        defaultBranch: string,
        preliminaryFiles?: FileChange[],
    ): Promise<CodeReviewConfigWithoutLLMProvider> {
        if (!parameter) {
            return this.DEFAULT_CONFIG;
        }

        const globalDelta = parameter?.configs;

        const repoConfig =
            parameter?.repositories?.find(
                (repo) => repo.id === repository.id,
            ) || ({} as RepositoryCodeReviewConfig);

        const repoDelta = repoConfig?.configs;

        const affectedPaths = this.extractUniqueDirectoryPaths(
            preliminaryFiles || [],
        );

        const directoryConfig = this.resolveConfigByDirectories(
            organizationAndTeamData,
            repoConfig,
            affectedPaths,
        );

        const directoryDelta = directoryConfig?.configs;

        const repositoryFileDelta = await this.getKodusConfigFile({
            organizationAndTeamData,
            repository,
            defaultBranch,
            overrideConfig: this.getFileOverridePreference(repoConfig),
        });

        const directoryFileDelta = await this.getKodusConfigFile({
            organizationAndTeamData,
            repository,
            directoryId: directoryConfig?.id,
            defaultBranch,
            overrideConfig: this.getFileOverridePreference(
                repoConfig,
                directoryConfig,
            ),
        });

        const merged = deepMerge(
            this.DEFAULT_CONFIG,
            globalDelta || {},
            repoDelta || {},
            repositoryFileDelta || {},
            directoryDelta || {},
            directoryFileDelta || {},
        );

        let configLevel = ConfigLevel.GLOBAL;
        let directoryId: string | undefined = undefined;
        let directoryPath: string | undefined = undefined;
        if (directoryDelta || directoryFileDelta) {
            configLevel = ConfigLevel.DIRECTORY;
            directoryId = directoryConfig?.id;
            directoryPath = this.getDirectoryPrimaryPath(directoryConfig);
        } else if (repoDelta || repositoryFileDelta) {
            configLevel = ConfigLevel.REPOSITORY;
        }

        return {
            ...merged,
            configLevel,
            directoryId,
            directoryPath,
            directoryFolders: this.getDirectoryFolders(directoryConfig),
        } as CodeReviewConfigWithoutLLMProvider;
    }

    private getFileOverridePreference(
        repoConfig: RepositoryCodeReviewConfig,
        directoryConfig?: DirectoryCodeReviewConfig,
    ): boolean {
        if (
            directoryConfig &&
            directoryConfig?.configs?.kodusConfigFileOverridesWebPreferences !==
                undefined
        ) {
            return directoryConfig.configs
                .kodusConfigFileOverridesWebPreferences;
        }

        if (
            repoConfig &&
            repoConfig?.configs?.kodusConfigFileOverridesWebPreferences !==
                undefined
        ) {
            return repoConfig.configs.kodusConfigFileOverridesWebPreferences;
        }

        return this.DEFAULT_CONFIG.kodusConfigFileOverridesWebPreferences;
    }

    private getDefaultConfigs(): CodeReviewConfig {
        try {
            const kodusConfigYMLfile = getDefaultKodusConfigFile();

            const DEFAULT_CONFIG = {
                ...kodusConfigYMLfile,
                languageResultPrompt: LanguageValue.ENGLISH,
                kodyRules: [],
            };

            return DEFAULT_CONFIG as CodeReviewConfig;
        } catch (error) {
            this.logger.error({
                message: 'Error getting default config file!',
                context: CodeBaseConfigService.name,
                error,
            });
        }
    }

    @ValidateCodeManagementIntegration()
    async getCodeManagementAuthenticationPlatform(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                status: true,
            });

            const platform = integration.platform.toLowerCase() as
                | 'github'
                | 'gitlab';
            const authDetails = integration?.authIntegration?.authDetails;
            const accessToken = await this.getAccessToken(
                platform,
                authDetails,
                organizationAndTeamData,
            );
            const integrationConfig = await this.getIntegrationConfig(
                integration.uuid,
                organizationAndTeamData.teamId,
            );

            return {
                codeManagementPat:
                    integrationConfig?.configValue || accessToken,
                platform,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting code management pat config',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData },
            });
            throw new Error('Error getting code management pat config', {
                cause: error,
            });
        }
    }

    @ValidateCodeManagementIntegration()
    async getCodeManagementPatConfigAndRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const config = await this.getCodeManagementBaseConfig(
            organizationAndTeamData,
        );
        return { ...config, codeManagementPat: config.codeManagementPat };
    }

    @ValidateCodeManagementIntegration()
    async getCodeManagementConfigAndRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const { platform, repositories } =
            await this.getCodeManagementBaseConfig(organizationAndTeamData);
        return { platform, repositories };
    }

    private async getCodeManagementBaseConfig(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                status: true,
            });

            const platform = integration.platform.toLowerCase() as
                | 'github'
                | 'gitlab';
            const authDetails = integration?.authIntegration?.authDetails;
            const accessToken = await this.getAccessToken(
                platform,
                authDetails,
                organizationAndTeamData,
            );

            const [integrationConfig, integrationConfigRepositories] =
                await Promise.all([
                    this.getIntegrationConfig(
                        integration.uuid,
                        organizationAndTeamData.teamId,
                    ),
                    this.integrationConfigService.findOne({
                        integration: { uuid: integration.uuid },
                        configKey: IntegrationConfigKey.REPOSITORIES,
                        team: { uuid: organizationAndTeamData.teamId },
                    }),
                ]);

            const repositories = await this.processRepositories(
                integrationConfigRepositories?.configValue || [],
                platform,
                integration,
            );

            return {
                codeManagementPat:
                    integrationConfig?.configValue || accessToken,
                platform,
                repositories,
            };
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting code management config with repositories',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData },
            });
            throw new Error(
                'Error getting code management config with repositories',
                { cause: error },
            );
        }
    }

    private async getAccessToken(
        platform: 'github' | 'gitlab',
        authDetails: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        if (platform === 'github') {
            return authDetails.authMode === AuthMode.TOKEN
                ? decrypt(authDetails?.authToken)
                : await this.codeManagementService.getAuthenticationOAuthToken({
                      organizationAndTeamData,
                  });
        }

        if (platform === 'gitlab') {
            return authDetails.authMode === AuthMode.TOKEN
                ? decrypt(authDetails?.accessToken)
                : authDetails.accessToken;
        }

        return '';
    }

    private async getIntegrationConfig(
        integrationUuid: string,
        teamId: string,
    ) {
        return this.integrationConfigService.findOne({
            integration: { uuid: integrationUuid },
            configKey: IntegrationConfigKey.CODE_MANAGEMENT_PAT,
            team: { uuid: teamId },
        });
    }

    private async processRepositories(
        repositories: any[],
        platform: string,
        integration: any,
    ) {
        return Promise.all(
            repositories.map(async (repository) => {
                const repositoryPath =
                    platform === 'gitlab'
                        ? repository.name.replace(/\s+/g, '')
                        : `${(integration?.authIntegration?.authDetails?.org || 'NOT FOUND').replace(/\s+/g, '')}/${repository.name.replace(/\s+/g, '')}`;

                return { ...repository, repositoryPath };
            }),
        );
    }

    private async getDefaultBranch(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
    ): Promise<string> {
        const defaultBranch = await this.codeManagementService.getDefaultBranch(
            { organizationAndTeamData, repository },
        );

        return defaultBranch;
    }

    async getKodusConfigFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        overrideConfig?: boolean;
        directoryPath?: string;
        directoryId?: string;
        defaultBranch?: string;
        removeProperties?: boolean;
    }): Promise<KodusConfigFile | undefined> {
        const {
            organizationAndTeamData,
            repository,
            directoryPath,
            directoryId,
            defaultBranch,
            overrideConfig = true,
            removeProperties = true,
        } = params;

        if (!overrideConfig) {
            return;
        }

        const hasIntegration =
            await this.codeManagementService.getTypeIntegration(
                organizationAndTeamData,
            );
        if (!hasIntegration) return;

        const defaultBranchName =
            defaultBranch ||
            (await this.getDefaultBranch(organizationAndTeamData, repository));

        const kodusConfigFileContent = await this.getConfigurationFile(
            organizationAndTeamData,
            repository,
            defaultBranchName,
            directoryPath,
            directoryId,
        );

        if (!kodusConfigFileContent) {
            return;
        }

        const parsedConfig = yaml.load(kodusConfigFileContent);
        const kodusConfigYMLfile =
            parsedConfig && typeof parsedConfig === 'object'
                ? (parsedConfig as KodusConfigFile)
                : ({} as KodusConfigFile);

        // strip properties not in default config
        for (const key in kodusConfigYMLfile) {
            if (!(key in this.DEFAULT_CONFIG)) {
                delete kodusConfigYMLfile[key as keyof KodusConfigFile];
            }
        }

        if (removeProperties) {
            delete kodusConfigYMLfile.version;
            delete kodusConfigYMLfile.kodusConfigFileOverridesWebPreferences;
        }

        return kodusConfigYMLfile;
    }

    private async getConfigurationFile(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        defaultBranchName = 'main',
        directoryPath?: string,
        directoryId?: string,
    ): Promise<string | null> {
        const configFileName = 'kodus-config.yml';
        let fullPath = configFileName;

        // Directory groups override config through the centralized config
        // repo only — there is no managed-repo override file at a group level.
        if (directoryId && !directoryPath) {
            return null;
        }

        if (directoryPath) {
            const normalizedPath = directoryPath.endsWith('/')
                ? directoryPath
                : `${directoryPath}/`;
            fullPath = `${normalizedPath}${configFileName}`;
        }

        const response =
            await this.codeManagementService.getRepositoryContentFile({
                organizationAndTeamData,
                repository: { id: repository.id, name: repository.name },
                file: { filename: fullPath },
                pullRequest: {
                    head: { ref: defaultBranchName },
                    base: { ref: defaultBranchName },
                },
            });

        if (!response || !response.data || !response.data.content) {
            return null;
        }

        let content = response.data.content;

        if (response.data.encoding === 'base64') {
            content = Buffer.from(content, 'base64').toString('utf-8');
        }

        return content;
    }

    private async getReviewModeConfigParameter(
        _organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ReviewModeConfig> {
        return ReviewModeConfig.HEAVY_MODE;
    }

    private async getKodyFineTuningConfigParameter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<KodyFineTuningConfig> {
        const kodyFineTuningConfig =
            await this.organizationParametersService.findByKey(
                OrganizationParametersKey.KODY_FINE_TUNING_CONFIG,
                organizationAndTeamData,
            );

        const enableService =
            kodyFineTuningConfig?.configValue?.enabled !== undefined
                ? kodyFineTuningConfig.configValue.enabled
                : true;

        return {
            enabled: enableService,
        };
    }

    private async getGlobalIgnorePaths(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string[]> {
        try {
            // Try to get from cache first
            const cachedData = await this.cacheService.getFromCache<{
                paths: string[];
                updatedAt: string;
            }>(GLOBAL_IGNORE_PATHS_CACHE_KEY);

            if (cachedData) {
                // Light query: fetch only updatedAt to check if cache is stale
                const dbUpdatedAt =
                    await this.globalParametersService.findUpdatedAtByKey(
                        GlobalParametersKey.IGNORE_PATHS_GLOBAL,
                    );

                // If no record in DB or cache is still valid, use cached data
                if (
                    !dbUpdatedAt ||
                    new Date(cachedData.updatedAt) >= new Date(dbUpdatedAt)
                ) {
                    this.logger.log({
                        message: 'Global ignore paths loaded from cache',
                        context: CodeBaseConfigService.name,
                        metadata: { organizationAndTeamData },
                    });
                    return cachedData.paths;
                }
            }

            // Fetch full record from database
            const globalParameters =
                await this.globalParametersService.findByKey(
                    GlobalParametersKey.IGNORE_PATHS_GLOBAL,
                );

            if (globalParameters?.configValue?.paths) {
                const paths = globalParameters.configValue.paths as string[];

                // Save to cache with updatedAt
                await this.cacheService.addToCache(
                    GLOBAL_IGNORE_PATHS_CACHE_KEY,
                    {
                        paths,
                        updatedAt:
                            globalParameters.updatedAt?.toISOString() ??
                            new Date().toISOString(),
                    },
                    GLOBAL_IGNORE_PATHS_CACHE_TTL,
                );

                this.logger.log({
                    message:
                        'Global ignore paths loaded from global parameters',
                    context: CodeBaseConfigService.name,
                    metadata: { organizationAndTeamData },
                });

                return paths;
            }

            // Fallback to JSON file
            this.logger.log({
                message: 'Global ignore paths loaded from file (fallback)',
                context: CodeBaseConfigService.name,
                metadata: { organizationAndTeamData },
            });

            return globalIgnorePathsJson?.paths ?? [];
        } catch (error) {
            this.logger.error({
                message:
                    'Error getting global ignore paths, using file fallback',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData },
            });

            return globalIgnorePathsJson?.paths ?? [];
        }
    }

    async getE2BIpAddress(): Promise<string | null> {
        try {
            const cachedData = await this.cacheService.getFromCache<{
                ip: string;
                updatedAt: string;
            }>(IP_E2B_CACHE_KEY);

            if (cachedData) {
                const dbUpdatedAt =
                    await this.globalParametersService.findUpdatedAtByKey(
                        GlobalParametersKey.IP_E2B,
                    );

                if (
                    !dbUpdatedAt ||
                    new Date(cachedData.updatedAt) >= new Date(dbUpdatedAt)
                ) {
                    return cachedData.ip;
                }
            }

            const globalParameters =
                await this.globalParametersService.findByKey(
                    GlobalParametersKey.IP_E2B,
                );

            if (globalParameters?.configValue?.ip) {
                const ip = globalParameters.configValue.ip as string;

                await this.cacheService.addToCache(
                    IP_E2B_CACHE_KEY,
                    {
                        ip,
                        updatedAt:
                            globalParameters.updatedAt?.toISOString() ??
                            new Date().toISOString(),
                    },
                    IP_E2B_CACHE_TTL,
                );

                return ip;
            }

            return null;
        } catch (error) {
            this.logger.error({
                message: 'Error getting E2B IP address',
                context: CodeBaseConfigService.name,
                error,
            });

            return null;
        }
    }

    /**
     * Extracts the primary path from a directory config, supporting both
     * the new `folders[]` format and the legacy `path` field.
     */
    private getDirectoryPrimaryPath(
        directoryConfig: DirectoryCodeReviewConfig | undefined,
    ): string | undefined {
        if (!directoryConfig) return undefined;
        return (
            directoryConfig.folders?.[0]?.path ??
            (directoryConfig as any).path ??
            undefined
        );
    }

    /**
     * Extracts folders from a directory config, supporting both
     * the new `folders[]` format and the legacy `path` field.
     */
    private getDirectoryFolders(
        directoryConfig: DirectoryCodeReviewConfig | undefined,
    ): Array<{ id: string; name: string; path: string }> | undefined {
        if (!directoryConfig) return undefined;
        if (directoryConfig.folders?.length > 0) return directoryConfig.folders;
        const legacyPath = (directoryConfig as any).path;
        if (legacyPath) {
            return [
                {
                    id: directoryConfig.id,
                    name: directoryConfig.name,
                    path: legacyPath,
                },
            ];
        }
        return undefined;
    }

    private resolveConfigByDirectories(
        organizationAndTeamData: OrganizationAndTeamData,
        repoConfig: RepositoryCodeReviewConfig,
        affectedPaths: string[] = [],
    ): DirectoryCodeReviewConfig | undefined {
        try {
            if (!repoConfig?.directories) {
                return;
            }

            const normalizePath = (path: string): string => {
                return path.startsWith('/') ? path.substring(1) : path;
            };

            const isPathCoveredByDirectory = (
                normalizedDir: string,
                normalizedFile: string,
            ): boolean => {
                if (normalizedDir === '') {
                    return true;
                }

                return (
                    normalizedFile === normalizedDir ||
                    normalizedFile.startsWith(normalizedDir + '/')
                );
            };

            // Build matchers from each group's folders (with legacy `path` fallback)
            const groupMatchers = repoConfig.directories.flatMap(
                (group: any) => {
                    const folders =
                        group.folders?.length > 0
                            ? group.folders
                            : group.path
                              ? [{ path: group.path }]
                              : [];
                    return folders.map((folder: any) => ({
                        group,
                        normalizedPath: normalizePath(folder.path),
                    }));
                },
            );

            const matchingEntries = groupMatchers.filter(
                ({ normalizedPath }) =>
                    affectedPaths.some((filePath: string) => {
                        const normalizedFile = normalizePath(filePath);

                        return isPathCoveredByDirectory(
                            normalizedPath,
                            normalizedFile,
                        );
                    }),
            );

            // Deduplicate by group id
            const matchingGroupIds = new Set(
                matchingEntries.map(({ group }) => group.id),
            );
            const matchingGroups = repoConfig.directories.filter((g: any) =>
                matchingGroupIds.has(g.id),
            );

            // If exactly 1 group matches, use its config
            // (files outside any group don't invalidate the match)
            // If 2+ groups match, fall back to repository config
            if (matchingGroups.length === 1) {
                return matchingGroups[0];
            }

            return;
        } catch (error) {
            this.logger.error({
                message: 'Error resolving config by directories',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData, affectedPaths },
            });

            return;
        }
    }

    async getDirectoryIdForPath(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        affectedPath: string,
    ): Promise<string | undefined> {
        try {
            const parameters = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            const repoConfig = parameters?.configValue?.repositories?.find(
                (repo) => repo.id === repository.id,
            );

            if (!repoConfig || !repoConfig.directories) {
                return;
            }

            const normalizePath = (path: string): string => {
                return path.startsWith('/') ? path.substring(1) : path;
            };

            const normalizedAffectedPath = normalizePath(affectedPath);

            // Build a flat list of { groupId, folderPath } from all groups (with legacy `path` fallback)
            const allFolderEntries = repoConfig.directories.flatMap(
                (group) => {
                    const folders =
                        group.folders?.length > 0
                            ? group.folders
                            : (group as any).path
                              ? [{ path: (group as any).path }]
                              : [];
                    return folders.map((folder) => ({
                        groupId: group.id,
                        folderPath: folder.path,
                    }));
                },
            );

            const matchingFolders = allFolderEntries.filter(
                ({ folderPath }) => {
                    const normalizedDirPath = normalizePath(folderPath);

                    if (normalizedDirPath === '') {
                        return true;
                    }

                    return (
                        normalizedAffectedPath === normalizedDirPath ||
                        normalizedAffectedPath.startsWith(
                            normalizedDirPath + '/',
                        )
                    );
                },
            );

            if (matchingFolders.length === 0) {
                return;
            }

            const mostSpecific = matchingFolders.reduce((bestMatch, current) =>
                current.folderPath.length > bestMatch.folderPath.length
                    ? current
                    : bestMatch,
            );

            return mostSpecific.groupId;
        } catch (error) {
            this.logger.error({
                message: 'Error resolving the most specific config for a path',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData, affectedPath, repository },
            });

            return;
        }
    }

    private extractUniqueDirectoryPaths(
        files: { filename: string }[] = [],
    ): string[] {
        const paths = new Set<string>();

        (files || []).forEach((file) => {
            const lastSlashIndex = file.filename.lastIndexOf('/');

            if (lastSlashIndex > 0) {
                const directoryPath = file.filename.substring(
                    0,
                    lastSlashIndex,
                );
                paths.add(directoryPath);
            }
        });

        return Array.from(paths);
    }
}
