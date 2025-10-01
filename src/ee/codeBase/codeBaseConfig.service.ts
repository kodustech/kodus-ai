import { Inject, Injectable } from '@nestjs/common';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import {
    CodeReviewConfig,
    CodeReviewVersion,
    KodusConfigFile,
    KodyFineTuningConfig,
    ReviewModeConfig,
    ReviewOptions,
    SuggestionControlConfig,
    SummaryConfig,
} from '@/config/types/general/codeReview.type';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { ValidateCodeManagementIntegration } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import { decrypt } from '@/shared/utils/crypto';
import { AuthMode } from '@/core/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import * as globalIgnorePathsJson from '@/shared/utils/codeBase/ignorePaths/generated/paths.json';
import * as yaml from 'js-yaml';
import validateKodusConfigFile, {
    getDefaultKodusConfigFile,
    isParameterValidInConfigFile,
} from '@/shared/utils/validateCodeReviewConfigFile';
import { ErrorObject } from 'ajv';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { ICodeBaseConfigService } from '@/core/domain/codeBase/contracts/CodeBaseConfigService.contract';
import { KodyRulesValidationService } from '../kodyRules/service/kody-rules-validation.service';
import { ReviewCadenceType } from '@/config/types/general/codeReview.type';
import { ConfigLevel } from '@/config/types/general/pullRequestMessages.type';

interface GetKodusConfigFileResponse {
    kodusConfigFile: Omit<KodusConfigFile, 'version'> | null;
    validationErrors: ErrorObject<string, Record<string, any>, unknown>[];
    isDeprecated?: boolean;
}

@Injectable()
export default class CodeBaseConfigService implements ICodeBaseConfigService {
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

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        private readonly codeManagementService: CodeManagementService,

        private readonly kodyRulesValidationService: KodyRulesValidationService,

        private readonly logger: PinoLoggerService,
    ) {
        this.DEFAULT_CONFIG = this.getDefaultConfigs();
    }

    @ValidateCodeManagementIntegration()
    async getConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        ignoreKodusConfigFile = false,
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

            const kodyRules = this.kodyRulesValidationService.filterKodyRules(
                kodyRulesEntity?.toObject()?.rules,
                repository.id,
            );

            const globalConfig = parameters?.configValue?.global || {};

            const repoConfig =
                parameters?.configValue?.repositories?.find(
                    (repo) => repo.id === repository.id.toString(),
                ) || {};

            let kodusConfigFile: Omit<KodusConfigFile, 'version'> | null;
            let validationErrors = [];

            const kodusConfigFileOverridesWebPreferences =
                this.getKodusConfigFileOverrides(repoConfig, globalConfig);

            if (
                kodusConfigFileOverridesWebPreferences &&
                ignoreKodusConfigFile !== true
            ) {
                const { isDeprecated, ...kodusConfigFileResponse } =
                    await this.getKodusConfigFile(
                        organizationAndTeamData,
                        repository,
                        defaultBranch,
                    );

                kodusConfigFile = kodusConfigFileResponse.kodusConfigFile;
                validationErrors = kodusConfigFileResponse.validationErrors;

                if (isDeprecated) {
                    this.logger.error({
                        message: 'Configuration file is deprecated',
                        context: CodeBaseConfigService.name,
                        error: new Error('Configuration file is deprecated.'),
                        metadata: { kodusConfigFile },
                    });
                }
            }

            const codeReviewVersion =
                (isParameterValidInConfigFile(
                    'codeReviewVersion',
                    validationErrors,
                )
                    ? kodusConfigFile?.codeReviewVersion
                    : undefined) ??
                repoConfig.codeReviewVersion ??
                globalConfig.codeReviewVersion ??
                this.DEFAULT_CONFIG.codeReviewVersion;

            const config: CodeReviewConfig = {
                ignorePaths: this.getIgnorePathsWithGlobal(
                    isParameterValidInConfigFile(
                        'ignorePaths',
                        validationErrors,
                    )
                        ? kodusConfigFile?.ignorePaths
                        : undefined,
                    repoConfig.ignorePaths,
                    globalConfig.ignorePaths,
                ),
                baseBranches: this.getBranchesConfig(
                    isParameterValidInConfigFile(
                        'baseBranches',
                        validationErrors,
                    )
                        ? kodusConfigFile?.baseBranches
                        : undefined,
                    repoConfig.baseBranches,
                    globalConfig.baseBranches,
                    defaultBranch,
                ),
                baseBranchDefault: defaultBranch,
                reviewOptions: this.mergeReviewOptions(
                    {
                        kodusConfig: kodusConfigFile?.reviewOptions,
                        validationErrors: validationErrors,
                    },
                    repoConfig.reviewOptions,
                    globalConfig.reviewOptions,
                    codeReviewVersion,
                ),
                summary: this.mergeSummaryConfig(
                    { kodusConfig: kodusConfigFile?.summary, validationErrors },
                    repoConfig.summary,
                    globalConfig.summary,
                ),
                suggestionControl: this.mergeSuggestionControlConfig(
                    {
                        kodusConfig: kodusConfigFile?.suggestionControl,
                        validationErrors,
                    },
                    repoConfig.suggestionControl,
                    globalConfig.suggestionControl,
                ),
                kodyRules: kodyRules,
                ignoredTitleKeywords: this.mergeArrayConfig(
                    isParameterValidInConfigFile(
                        'ignoredTitleKeywords',
                        validationErrors,
                    )
                        ? kodusConfigFile?.ignoredTitleKeywords
                        : undefined,
                    repoConfig.ignoredTitleKeywords,
                    globalConfig.ignoredTitleKeywords,
                    this.DEFAULT_CONFIG.ignoredTitleKeywords,
                ),
                automatedReviewActive:
                    (isParameterValidInConfigFile(
                        'automatedReviewActive',
                        validationErrors,
                    )
                        ? kodusConfigFile?.automatedReviewActive
                        : undefined) ??
                    repoConfig.automatedReviewActive ??
                    globalConfig.automatedReviewActive ??
                    this.DEFAULT_CONFIG.automatedReviewActive,
                reviewCadence:
                    (isParameterValidInConfigFile(
                        'reviewCadence',
                        validationErrors,
                    )
                        ? kodusConfigFile?.reviewCadence
                        : undefined) ??
                    repoConfig.reviewCadence ??
                    globalConfig.reviewCadence ??
                    this.DEFAULT_CONFIG.reviewCadence,
                languageResultPrompt:
                    language?.configValue ||
                    this.DEFAULT_CONFIG.languageResultPrompt,
                reviewModeConfig,
                kodyFineTuningConfig: {
                    ...kodyFineTuningConfig,
                    fineTuningEnabled: repoConfig.kodyFineTuningConfig?.fineTuningEnabled ?? kodyFineTuningConfig.fineTuningEnabled,
                },
                pullRequestApprovalActive:
                    (isParameterValidInConfigFile(
                        'pullRequestApprovalActive',
                        validationErrors,
                    )
                        ? kodusConfigFile?.pullRequestApprovalActive
                        : undefined) ??
                    repoConfig.pullRequestApprovalActive ??
                    globalConfig.pullRequestApprovalActive ??
                    this.DEFAULT_CONFIG.pullRequestApprovalActive,
                kodusConfigFileOverridesWebPreferences:
                    kodusConfigFileOverridesWebPreferences,
                isRequestChangesActive:
                    (isParameterValidInConfigFile(
                        'isRequestChangesActive',
                        validationErrors,
                    )
                        ? kodusConfigFile?.isRequestChangesActive
                        : undefined) ??
                    repoConfig.isRequestChangesActive ??
                    globalConfig.isRequestChangesActive ??
                    this.DEFAULT_CONFIG.isRequestChangesActive,
                runOnDraft:
                    (isParameterValidInConfigFile(
                        'runOnDraft',
                        validationErrors,
                    )
                        ? kodusConfigFile?.runOnDraft
                        : undefined) ??
                    repoConfig.runOnDraft ??
                    globalConfig.runOnDraft ??
                    this.DEFAULT_CONFIG.runOnDraft,
                codeReviewVersion: codeReviewVersion,
            };

            return config;
        } catch (error) {
            this.logger.error({
                message: 'Error getting code review config parameters',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData },
            });
            throw new Error('Error getting code review config parameters');
        }
    }

    getDefaultConfigs(): CodeReviewConfig {
        try {
            const kodusConfigYMLfile = getDefaultKodusConfigFile();

            // Complete CodeReviewConfig with missing values
            const DEFAULT_CONFIG: CodeReviewConfig = {
                ...kodusConfigYMLfile,
                languageResultPrompt: LanguageValue.ENGLISH,
                kodyRules: [],
                kodusConfigFileOverridesWebPreferences: false,
                reviewCadence: {
                    type: ReviewCadenceType.AUTOMATIC,
                    timeWindow: 0,
                    pushesToTrigger: 0,
                },
                codeReviewVersion: CodeReviewVersion.v2,
            };

            return DEFAULT_CONFIG;
        } catch (error) {
            this.logger.error({
                message: 'Error getting default config file!',
                context: CodeBaseConfigService.name,
                error,
            });
        }
    }

    private getKodusConfigFileOverrides(
        repoConfig?: CodeReviewConfig,
        globalConfig?: CodeReviewConfig,
    ) {
        return (
            repoConfig?.kodusConfigFileOverridesWebPreferences ??
            globalConfig?.kodusConfigFileOverridesWebPreferences ??
            this.DEFAULT_CONFIG.kodusConfigFileOverridesWebPreferences
        );
    }

    private getIgnorePathsWithGlobal(
        kodusConfigIgnorePath: string[] | undefined,
        repoIgnorePaths: string[] | undefined,
        globalIgnorePaths: string[] | undefined,
    ): string[] {
        // Generate ignore paths array with either the repository, global or default ignore paths
        const ignorePaths = this.mergeArrayConfig(
            kodusConfigIgnorePath,
            repoIgnorePaths,
            globalIgnorePaths,
            this.DEFAULT_CONFIG.ignorePaths,
        );

        // Merge with global ignore paths
        return ignorePaths.concat(globalIgnorePathsJson?.paths ?? []);
    }

    private mergeArrayConfig<T>(
        kodusConfig: T[] | undefined,
        repo: T[] | undefined,
        global: T[] | undefined,
        defaultValue: T[],
    ): T[] {
        if (kodusConfig?.length) {
            return kodusConfig;
        }

        if (repo?.length) {
            return repo;
        }
        if (global?.length) {
            return global;
        }

        return defaultValue;
    }

    private getBranchesConfig(
        kodusConfig: string[] | undefined,
        repoBranches: string[] | undefined,
        globalBranches: string[] | undefined,
        defaultBranch: string,
    ): string[] {
        const baseBranches = this.mergeArrayConfig(
            kodusConfig,
            repoBranches,
            globalBranches,
            [],
        );

        return [...new Set([...baseBranches, defaultBranch])];
    }

    private mergeReviewOptions(
        kodusOptions?: {
            kodusConfig?: Partial<ReviewOptions>;
            validationErrors: ErrorObject<
                string,
                Record<string, any>,
                unknown
            >[];
        },
        repo?: Partial<any>,
        global?: Partial<any>,
        codeReviewVersion?: CodeReviewVersion,
    ): ReviewOptions {
        const defaultOptions = this.DEFAULT_CONFIG.reviewOptions;
        const { kodusConfig, validationErrors } = kodusOptions;

        if (codeReviewVersion === CodeReviewVersion.LEGACY) {
            return {
                security:
                    (isParameterValidInConfigFile('security', validationErrors)
                        ? kodusConfig?.security
                        : undefined) ??
                    repo?.security ??
                    global?.security ??
                    defaultOptions.security,

                code_style:
                    (isParameterValidInConfigFile(
                        'code_style',
                        validationErrors,
                    )
                        ? kodusConfig?.code_style
                        : undefined) ??
                    repo?.code_style ??
                    global?.code_style ??
                    defaultOptions.code_style,

                kody_rules:
                    (isParameterValidInConfigFile(
                        'kody_rules',
                        validationErrors,
                    )
                        ? kodusConfig?.kody_rules
                        : undefined) ??
                    repo?.kody_rules ??
                    global?.kody_rules ??
                    defaultOptions.kody_rules,

                refactoring:
                    (isParameterValidInConfigFile(
                        'refactoring',
                        validationErrors,
                    )
                        ? kodusConfig?.refactoring
                        : undefined) ??
                    repo?.refactoring ??
                    global?.refactoring ??
                    defaultOptions.refactoring,

                error_handling:
                    (isParameterValidInConfigFile(
                        'error_handling',
                        validationErrors,
                    )
                        ? kodusConfig?.error_handling
                        : undefined) ??
                    repo?.error_handling ??
                    global?.error_handling ??
                    defaultOptions.error_handling,

                maintainability:
                    (isParameterValidInConfigFile(
                        'maintainability',
                        validationErrors,
                    )
                        ? kodusConfig?.maintainability
                        : undefined) ??
                    repo?.maintainability ??
                    global?.maintainability ??
                    defaultOptions.maintainability,

                potential_issues:
                    (isParameterValidInConfigFile(
                        'potential_issues',
                        validationErrors,
                    )
                        ? kodusConfig?.potential_issues
                        : undefined) ??
                    repo?.potential_issues ??
                    global?.potential_issues ??
                    defaultOptions.potential_issues,

                documentation_and_comments:
                    (isParameterValidInConfigFile(
                        'documentation_and_comments',
                        validationErrors,
                    )
                        ? kodusConfig?.documentation_and_comments
                        : undefined) ??
                    repo?.documentation_and_comments ??
                    global?.documentation_and_comments ??
                    defaultOptions.documentation_and_comments,

                performance_and_optimization:
                    (isParameterValidInConfigFile(
                        'performance_and_optimization',
                        validationErrors,
                    )
                        ? kodusConfig?.performance_and_optimization
                        : undefined) ??
                    repo?.performance_and_optimization ??
                    global?.performance_and_optimization ??
                    defaultOptions.performance_and_optimization,

                breaking_changes:
                    (isParameterValidInConfigFile(
                        'breaking_changes',
                        validationErrors,
                    )
                        ? kodusConfig?.breaking_changes
                        : undefined) ??
                    repo?.breaking_changes ??
                    global?.breaking_changes ??
                    defaultOptions.breaking_changes,

                cross_file:
                    (isParameterValidInConfigFile(
                        'cross_file',
                        validationErrors,
                    )
                        ? kodusConfig?.cross_file
                        : undefined) ??
                    repo?.cross_file ??
                    global?.cross_file ??
                    defaultOptions.cross_file,
            };
        } else {
            return {
                security:
                    (isParameterValidInConfigFile('security', validationErrors)
                        ? kodusConfig?.security
                        : undefined) ??
                    repo?.security ??
                    global?.security ??
                    defaultOptions.security,
                bug:
                    (isParameterValidInConfigFile('bug', validationErrors)
                        ? kodusConfig?.bug
                        : undefined) ??
                    repo?.bug ??
                    global?.bug ??
                    defaultOptions.bug,
                performance:
                    (isParameterValidInConfigFile(
                        'performance',
                        validationErrors,
                    )
                        ? kodusConfig?.performance
                        : undefined) ??
                    repo?.performance ??
                    global?.performance ??
                    defaultOptions.performance,
                breaking_changes:
                    (isParameterValidInConfigFile(
                        'breaking_changes',
                        validationErrors,
                    )
                        ? kodusConfig?.breaking_changes
                        : undefined) ??
                    repo?.breaking_changes ??
                    global?.breaking_changes ??
                    defaultOptions.breaking_changes,
                cross_file:
                    (isParameterValidInConfigFile(
                        'cross_file',
                        validationErrors,
                    )
                        ? kodusConfig?.cross_file
                        : undefined) ??
                    repo?.cross_file ??
                    global?.cross_file ??
                    defaultOptions.cross_file,
                kody_rules: true,
            };
        }
    }

    private mergeSummaryConfig(
        kodusConfigOptions?: {
            kodusConfig?: Partial<SummaryConfig>;
            validationErrors: ErrorObject<
                string,
                Record<string, any>,
                unknown
            >[];
        },
        repo?: Partial<SummaryConfig>,
        global?: Partial<SummaryConfig>,
    ): SummaryConfig {
        const defaultSummary = this.DEFAULT_CONFIG.summary;
        const { kodusConfig, validationErrors } = kodusConfigOptions;

        return {
            generatePRSummary:
                (isParameterValidInConfigFile(
                    'generatePRSummary',
                    validationErrors,
                )
                    ? kodusConfig?.generatePRSummary
                    : undefined) ??
                repo?.generatePRSummary ??
                global?.generatePRSummary ??
                defaultSummary.generatePRSummary,
            customInstructions:
                (isParameterValidInConfigFile(
                    'customInstructions',
                    validationErrors,
                )
                    ? kodusConfig?.customInstructions
                    : undefined) ??
                repo?.customInstructions ??
                global?.customInstructions ??
                defaultSummary.customInstructions,
            behaviourForExistingDescription:
                (isParameterValidInConfigFile(
                    'behaviourForExistingDescription',
                    validationErrors,
                )
                    ? kodusConfig?.behaviourForExistingDescription
                    : undefined) ??
                repo?.behaviourForExistingDescription ??
                global?.behaviourForExistingDescription ??
                defaultSummary.behaviourForExistingDescription,
            behaviourForNewCommits:
                (isParameterValidInConfigFile(
                    'behaviourForNewCommits',
                    validationErrors,
                )
                    ? kodusConfig?.behaviourForNewCommits
                    : undefined) ??
                repo?.behaviourForNewCommits ??
                global?.behaviourForNewCommits ??
                defaultSummary.behaviourForNewCommits,
        };
    }

    private mergeSuggestionControlConfig(
        kodusConfigOptions?: {
            kodusConfig: Partial<SuggestionControlConfig>;
            validationErrors: ErrorObject<
                string,
                Record<string, any>,
                unknown
            >[];
        },
        repo?: Partial<SuggestionControlConfig>,
        global?: Partial<SuggestionControlConfig>,
    ): SuggestionControlConfig {
        const { kodusConfig, validationErrors } = kodusConfigOptions;

        return {
            groupingMode:
                (isParameterValidInConfigFile('groupingMode', validationErrors)
                    ? kodusConfig?.groupingMode
                    : undefined) ??
                repo?.groupingMode ??
                global?.groupingMode ??
                this.DEFAULT_CONFIG.suggestionControl.groupingMode,
            limitationType:
                (isParameterValidInConfigFile(
                    'limitationType',
                    validationErrors,
                )
                    ? kodusConfig?.limitationType
                    : undefined) ??
                repo?.limitationType ??
                global?.limitationType ??
                this.DEFAULT_CONFIG.suggestionControl.limitationType,
            maxSuggestions:
                (isParameterValidInConfigFile(
                    'maxSuggestions',
                    validationErrors,
                )
                    ? kodusConfig?.maxSuggestions
                    : undefined) ??
                repo?.maxSuggestions ??
                global?.maxSuggestions ??
                this.DEFAULT_CONFIG.suggestionControl.maxSuggestions,
            severityLevelFilter:
                (isParameterValidInConfigFile(
                    'severityLevelFilter',
                    validationErrors,
                )
                    ? kodusConfig?.severityLevelFilter
                    : undefined) ??
                repo?.severityLevelFilter ??
                global?.severityLevelFilter ??
                this.DEFAULT_CONFIG.suggestionControl.severityLevelFilter,
            applyFiltersToKodyRules:
                (isParameterValidInConfigFile(
                    'applyFiltersToKodyRules',
                    validationErrors,
                )
                    ? kodusConfig?.applyFiltersToKodyRules
                    : undefined) ??
                repo?.applyFiltersToKodyRules ??
                global?.applyFiltersToKodyRules ??
                this.DEFAULT_CONFIG.suggestionControl.applyFiltersToKodyRules,
            severityLimits:
                (isParameterValidInConfigFile(
                    'severityLimits',
                    validationErrors,
                )
                    ? kodusConfig?.severityLimits
                    : undefined) ??
                repo?.severityLimits ??
                global?.severityLimits ??
                this.DEFAULT_CONFIG.suggestionControl.severityLimits,
        };
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
            throw new Error('Error getting code management pat config');
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

    private async getKodusConfigFile(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        defaultBranchName: string,
    ): Promise<GetKodusConfigFileResponse> {
        const kodusConfigFileContent = await this.getConfigurationFile(
            organizationAndTeamData,
            repository,
            defaultBranchName,
        );

        if (!kodusConfigFileContent) {
            return { kodusConfigFile: null, validationErrors: [] };
        }

        const kodusConfigYMLfile = yaml.load(
            kodusConfigFileContent,
        ) as KodusConfigFile;

        const {
            isValidConfigFile: isKodusConfigFileValid,
            errorMessages,
            validationErrors,
            isDeprecated,
        } = validateKodusConfigFile(kodusConfigYMLfile);

        if (!isKodusConfigFileValid) {
            this.logger.error({
                message: 'Configuration file is invalid',
                context: CodeBaseConfigService.name,
                error: new Error(errorMessages),
                metadata: { kodusConfigYMLfile },
            });
        }

        const { version, ...kodusConfigYMLFileWithoutVersion } =
            kodusConfigYMLfile;

        return {
            kodusConfigFile: kodusConfigYMLFileWithoutVersion,
            validationErrors: validationErrors ? validationErrors : [],
            isDeprecated,
        };
    }

    private async getConfigurationFile(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        defaultBranchName = 'main',
    ): Promise<string | null> {
        const configFileName = 'kodus-config.yml';
        const response =
            await this.codeManagementService.getRepositoryContentFile({
                organizationAndTeamData,
                repository: { id: repository.id, name: repository.name },
                file: { filename: configFileName },
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

    private async getDirectoryConfigurationFile(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        directoryPath: string,
        defaultBranchName = 'main',
    ): Promise<string | null> {
        const configFileName = 'kodus-config.yml';
        // Garante que o diretório termine com / para construir o caminho correto
        const normalizedPath = directoryPath.endsWith('/')
            ? directoryPath
            : `${directoryPath}/`;
        const fullPath = `${normalizedPath}${configFileName}`;

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

    private async getDirectoryKodusConfigFile(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        directoryPath: string,
        defaultBranchName: string,
    ): Promise<GetKodusConfigFileResponse> {
        const kodusConfigFileContent = await this.getDirectoryConfigurationFile(
            organizationAndTeamData,
            repository,
            directoryPath,
            defaultBranchName,
        );

        if (!kodusConfigFileContent) {
            return { kodusConfigFile: null, validationErrors: [] };
        }

        const kodusConfigYMLfile = yaml.load(
            kodusConfigFileContent,
        ) as KodusConfigFile;

        const {
            isValidConfigFile: isKodusConfigFileValid,
            errorMessages,
            validationErrors,
            isDeprecated,
        } = validateKodusConfigFile(kodusConfigYMLfile);

        if (!isKodusConfigFileValid) {
            this.logger.error({
                message: 'Directory configuration file is invalid',
                context: CodeBaseConfigService.name,
                error: new Error(errorMessages),
                metadata: { kodusConfigYMLfile, directoryPath },
            });
        }

        const { version, ...kodusConfigYMLFileWithoutVersion } =
            kodusConfigYMLfile;

        return {
            kodusConfigFile: kodusConfigYMLFileWithoutVersion,
            validationErrors: validationErrors ? validationErrors : [],
            isDeprecated,
        };
    }

    private async getReviewModeConfigParameter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ReviewModeConfig> {
        try {
            const reviewModeConfig =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.REVIEW_MODE_CONFIG,
                    organizationAndTeamData,
                );

            return (
                reviewModeConfig?.configValue?.reviewMode ??
                ReviewModeConfig.LIGHT_MODE_FULL
            );
        } catch (error) {
            this.logger.error({
                message: 'Error getting review mode config',
                error,
                context: CodeBaseConfigService.name,
                metadata: { organizationAndTeamData },
            });

            return ReviewModeConfig.LIGHT_MODE_FULL;
        }
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
            fineTuningEnabled: true, // Default to true for per-repository toggle
        };
    }

    // Adicionar estes métodos ao CodeBaseConfigService

    /**
     * Verifica se existem configurações por diretório para o repositório específico
     * e retorna as configs encontradas para evitar nova busca no banco
     */
    async getDirectoryConfigs(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
    ): Promise<{ hasConfigs: boolean; repoConfig?: any; parameters?: any }> {
        try {
            const parameters = await this.parametersService.findOne({
                configKey: ParametersKey.CODE_REVIEW_CONFIG,
                team: { uuid: organizationAndTeamData.teamId },
            });

            if (!parameters?.configValue?.repositories) {
                return { hasConfigs: false };
            }

            const repoConfig = parameters.configValue.repositories.find(
                (repo: any) => repo.id === repository.id.toString(),
            );

            const hasConfigs = !!(
                repoConfig?.directories && repoConfig.directories.length > 0
            );

            return {
                hasConfigs,
                repoConfig: hasConfigs ? repoConfig : undefined,
                parameters: hasConfigs ? parameters : undefined,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error checking directory configs',
                context: CodeBaseConfigService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repositoryId: repository.id,
                },
            });
            return { hasConfigs: false };
        }
    }

    /**
     * Resolve configuração baseada nos diretórios afetados pelos arquivos alterados
     */
    async resolveConfigByDirectories(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        affectedPaths: string[],
        repoConfig: any,
    ): Promise<CodeReviewConfig> {
        try {
            if (!repoConfig?.directories) {
                return this.getConfig(organizationAndTeamData, repository);
            }

            // Função para normalizar paths (remover barra inicial para comparação consistente)
            const normalizePath = (path: string): string => {
                return path.startsWith('/') ? path.substring(1) : path;
            };

            // Encontrar diretórios configurados que são afetados pelos arquivos alterados
            const matchingDirectories = repoConfig.directories.filter(
                (dir: any) => {
                    const normalizedDirPath = normalizePath(dir.path);
                    return affectedPaths.some((filePath: string) => {
                        const normalizedFilePath = normalizePath(filePath);
                        return (
                            normalizedFilePath === normalizedDirPath ||
                            normalizedFilePath.startsWith(
                                normalizedDirPath + '/',
                            )
                        );
                    });
                },
            );

            if (matchingDirectories.length === 0) {
                // Nenhum diretório configurado afetado, usar config normal (repo ou global)
                return this.getConfig(organizationAndTeamData, repository);
            }

            if (matchingDirectories.length === 1) {
                // Apenas um diretório configurado afetado, usar sua config
                return this.buildConfigFromDirectory(
                    matchingDirectories[0],
                    organizationAndTeamData,
                    repository,
                );
            }

            // Múltiplos diretórios configurados afetados, usar config do nível superior
            return this.getConfig(organizationAndTeamData, repository);
        } catch (error) {
            this.logger.error({
                message: 'Error resolving config by directories',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData, affectedPaths },
            });

            // Fallback para config normal
            return this.getConfig(organizationAndTeamData, repository);
        }
    }

    /**
     * Resolves the most specific configuration for a single file path based on directory hierarchy.
     * It finds all matching parent directories for the given path and selects the one with the longest,
     * most specific path. Falls back to the repository-level config if no directory config matches.
     *
     * @param organizationAndTeamData - Data for the organization and team.
     * @param repository - The repository details.
     * @param affectedPath - The single file path to resolve the config for.
     * @param repoConfig - The repository's configuration object, including directory configs.
     * @returns A promise that resolves to the most specific CodeReviewConfig.
     */
    async resolveMostSpecificConfigForPath(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        affectedPath: string,
        repoConfig: any,
    ): Promise<CodeReviewConfig> {
        try {
            // If no directories are configured, use the default repository config immediately.
            if (
                !repoConfig?.directories ||
                repoConfig.directories.length === 0
            ) {
                return this.getConfig(organizationAndTeamData, repository);
            }

            const normalizePath = (path: string): string => {
                return path.startsWith('/') ? path.substring(1) : path;
            };

            const normalizedAffectedPath = normalizePath(affectedPath);

            // 1. Find all configured directories that are a parent of (or match) the affected path.
            const matchingDirectories = repoConfig.directories.filter(
                (dir: any) => {
                    const normalizedDirPath = normalizePath(dir.path);

                    // The root directory ('/' or '') is always a potential match.
                    if (normalizedDirPath === '') {
                        return true;
                    }

                    // A directory matches if it's identical to the path or is a prefix.
                    // e.g., 'foo/bar' matches 'foo/bar' and 'foo/bar/baz.ts'.
                    return (
                        normalizedAffectedPath === normalizedDirPath ||
                        normalizedAffectedPath.startsWith(
                            normalizedDirPath + '/',
                        )
                    );
                },
            );

            // 2. If no directories match, fall back to the repository-level config.
            if (matchingDirectories.length === 0) {
                return this.getConfig(organizationAndTeamData, repository);
            }

            // 3. From the matches, find the most specific one (i.e., the one with the longest path).
            const mostSpecificDirectory = matchingDirectories.reduce(
                (bestMatch, currentDir) => {
                    return currentDir.path.length > bestMatch.path.length
                        ? currentDir
                        : bestMatch;
                },
            );

            // 4. Build and return the configuration from the most specific directory found.
            return this.buildConfigFromDirectory(
                mostSpecificDirectory,
                organizationAndTeamData,
                repository,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error resolving the most specific config for a path',
                context: CodeBaseConfigService.name,
                error,
                metadata: { organizationAndTeamData, affectedPath, repository },
            });

            // Fallback to the default repository config in case of any error.
            return this.getConfig(organizationAndTeamData, repository);
        }
    }

    /**
     * Constrói a configuração baseada na config de um diretório específico
     * Hierarquia: 1º arquivo yml no diretório → 2º config do banco → 3º default
     */
    private async buildConfigFromDirectory(
        directoryConfig: any,
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
    ): Promise<CodeReviewConfig> {
        try {
            const [
                language,
                defaultBranch,
                kodyRulesForDirectory,
                reviewModeConfig,
                kodyFineTuningConfig,
                kodyRulesEntity,
            ] = await Promise.all([
                this.parametersService.findByKey(
                    ParametersKey.LANGUAGE_CONFIG,
                    organizationAndTeamData,
                ),
                this.getDefaultBranch(organizationAndTeamData, repository),
                this.kodyRulesService.findRulesByDirectory(
                    organizationAndTeamData.organizationId,
                    repository.id,
                    directoryConfig.id,
                ),
                this.getReviewModeConfigParameter(organizationAndTeamData),
                this.getKodyFineTuningConfigParameter(organizationAndTeamData),
                this.kodyRulesService.findByOrganizationId(
                    organizationAndTeamData.organizationId,
                ),
            ]);

            // 1º: Tentar buscar arquivo yml no diretório específico
            let kodusConfigFile: Omit<KodusConfigFile, 'version'> | null = null;
            let validationErrors = [];
            let isDeprecated = false;

            try {
                const directoryConfigResult =
                    await this.getDirectoryKodusConfigFile(
                        organizationAndTeamData,
                        repository,
                        directoryConfig.path,
                        defaultBranch,
                    );
                kodusConfigFile = directoryConfigResult.kodusConfigFile;
                validationErrors = directoryConfigResult.validationErrors;
                isDeprecated = directoryConfigResult.isDeprecated ?? false;

                if (kodusConfigFile) {
                    this.logger.log({
                        message:
                            'Using directory-specific kodus-config.yml file',
                        context: CodeBaseConfigService.name,
                        metadata: {
                            directoryPath: directoryConfig.path,
                            repository: repository.name,
                            isDeprecated,
                        },
                    });
                }
            } catch (error) {
                this.logger.warn({
                    message:
                        'Error loading directory configuration file, falling back to database config',
                    context: CodeBaseConfigService.name,
                    error,
                    metadata: { directoryPath: directoryConfig.path },
                });
            }

            const repositoryKodyRules = this.kodyRulesValidationService
                .filterKodyRules(
                    kodyRulesEntity?.toObject()?.rules,
                    repository.id,
                )
                .filter((rule) => rule?.directoryId !== directoryConfig.id);

            const kodyRules = [
                ...repositoryKodyRules,
                ...kodyRulesForDirectory,
            ];

            // Determinar a fonte da configuração e aplicar hierarquia
            const configSource = kodusConfigFile || directoryConfig;
            const codeReviewVersion =
                configSource.codeReviewVersion ??
                this.DEFAULT_CONFIG.codeReviewVersion;

            const config: CodeReviewConfig = {
                ignorePaths: this.getIgnorePathsWithGlobal(
                    configSource.ignorePaths,
                    undefined, // não há repo/global config específica no contexto de diretório
                    undefined,
                ),
                baseBranches: configSource.baseBranches?.length
                    ? configSource.baseBranches
                    : [defaultBranch],
                reviewOptions: kodusConfigFile
                    ? this.mergeReviewOptions(
                          {
                              kodusConfig: kodusConfigFile.reviewOptions,
                              validationErrors: validationErrors,
                          },
                          undefined, // repo
                          undefined, // global
                          codeReviewVersion,
                      )
                    : this.mergeReviewOptions(
                          {
                              kodusConfig: undefined,
                              validationErrors: [],
                          },
                          directoryConfig.reviewOptions,
                          undefined, // global
                          codeReviewVersion,
                      ),
                summary: configSource.summary || this.DEFAULT_CONFIG.summary,
                suggestionControl:
                    configSource.suggestionControl ||
                    this.DEFAULT_CONFIG.suggestionControl,
                kodyRules: kodyRules,
                ignoredTitleKeywords: configSource.ignoredTitleKeywords || [],
                automatedReviewActive:
                    configSource.automatedReviewActive ??
                    this.DEFAULT_CONFIG.automatedReviewActive,
                reviewCadence:
                    configSource.reviewCadence ||
                    this.DEFAULT_CONFIG.reviewCadence,
                languageResultPrompt:
                    language?.configValue ||
                    this.DEFAULT_CONFIG.languageResultPrompt,
                reviewModeConfig,
                kodyFineTuningConfig: {
                    ...kodyFineTuningConfig,
                    fineTuningEnabled: configSource.kodyFineTuningConfig?.fineTuningEnabled ?? kodyFineTuningConfig.fineTuningEnabled,
                },
                pullRequestApprovalActive:
                    configSource.pullRequestApprovalActive ??
                    this.DEFAULT_CONFIG.pullRequestApprovalActive,
                kodusConfigFileOverridesWebPreferences: kodusConfigFile
                    ? true // Se veio do arquivo yml, sempre override
                    : (directoryConfig.kodusConfigFileOverridesWebPreferences ??
                      this.DEFAULT_CONFIG
                          .kodusConfigFileOverridesWebPreferences),
                isRequestChangesActive:
                    configSource.isRequestChangesActive ??
                    this.DEFAULT_CONFIG.isRequestChangesActive,
                kodyRulesGeneratorEnabled:
                    configSource.kodyRulesGeneratorEnabled ??
                    this.DEFAULT_CONFIG.kodyRulesGeneratorEnabled,
                isCommitMode:
                    configSource.isCommitMode ??
                    this.DEFAULT_CONFIG.isCommitMode,
                configLevel: ConfigLevel.DIRECTORY,
                directoryId: directoryConfig.id,
                directoryPath: directoryConfig.path,
                codeReviewVersion: codeReviewVersion,
            };

            return config;
        } catch (error) {
            this.logger.error({
                message: 'Error building config from directory',
                context: CodeBaseConfigService.name,
                error,
                metadata: { directoryConfig, organizationAndTeamData },
            });

            // Fallback para config normal
            return this.getConfig(organizationAndTeamData, repository);
        }
    }

    /**
     * Extrai caminhos únicos dos arquivos para identificar diretórios afetados
     */
    extractUniqueDirectoryPaths(files: { filename: string }[]): string[] {
        const paths = new Set<string>();

        files.forEach((file) => {
            const parts = file.filename.split('/');

            // Gerar todos os caminhos possíveis (do mais específico ao mais geral)
            for (let i = parts.length - 1; i > 0; i--) {
                const path = parts.slice(0, i).join('/');
                paths.add(path);
            }
        });

        return Array.from(paths);
    }
}
