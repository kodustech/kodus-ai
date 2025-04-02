import { Inject, Injectable } from '@nestjs/common';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import {
    BehaviourForExistingDescription,
    CodeReviewConfigWithoutLLMProvider,
    GroupingModeSuggestions,
    LimitationType,
    SuggestionControlConfig,
    SummaryConfig,
} from '@/config/types/general/codeReview.type';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';

interface Body {
    organizationAndTeamData: OrganizationAndTeamData;
    configValue: any;
    repositoryId?: string;
}

interface ICodeRepository {
    avatar_url?: string;
    default_branch: string;
    http_url: string;
    id: string;
    language: string;
    name: string;
    organizationName: string;
    selected: string;
    visibility: 'private' | 'public';
}

interface IFilteredCodeRepository {
    id: string;
    name: string;
    isSelected: boolean;
}

interface IRepositoryCodeReviewConfig
    extends CodeReviewConfigWithoutLLMProvider {
    id: string;
    name: string;
}
interface ICodeReviewParameter {
    global: CodeReviewConfigWithoutLLMProvider;
    repositories: Array<IRepositoryCodeReviewConfig | IFilteredCodeRepository>;
}

@Injectable()
export class UpdateOrCreateCodeReviewParameterUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(body: Body): Promise<ParametersEntity | boolean> {
        try {
            const { organizationAndTeamData, configValue, repositoryId } = body;

            const codeReviewConfigs: ICodeReviewParameter =
                await this.getCodeReviewConfigs(organizationAndTeamData);
            const codeRepositories = await this.getFormattedRepositories(
                organizationAndTeamData,
            );

            const filteredRepositoryInfo: IFilteredCodeRepository[] =
                this.filterRepositoryInfo(codeRepositories);

            if (!codeReviewConfigs) {
                return await this.createNewConfig(
                    organizationAndTeamData,
                    configValue,
                    filteredRepositoryInfo,
                );
            }

            this.updateExistingGlobalConfig(
                codeReviewConfigs,
                filteredRepositoryInfo,
            );

            if (!repositoryId) {
                return await this.updateGlobalConfig(
                    organizationAndTeamData,
                    codeReviewConfigs,
                    configValue,
                );
            }

            return await this.updateSpecificRepositoryConfig(
                organizationAndTeamData,
                codeReviewConfigs,
                repositoryId,
                configValue,
            );
        } catch (error) {
            this.handleError(error, body);
            throw new Error('Error creating or updating parameters');
        }
    }

    private getDefaultPRSummaryConfig(): SummaryConfig {
        return {
            generatePRSummary: true,
            customInstructions: '',
            behaviourForExistingDescription:
                BehaviourForExistingDescription.REPLACE,
        };
    }

    private getDefaultSuggestionControlConfig(): SuggestionControlConfig {
        return {
            groupingMode: GroupingModeSuggestions.FULL,
            limitationType: LimitationType.PR,
            maxSuggestions: 9,
            severityLevelFilter: SeverityLevel.MEDIUM,
        };
    }

    private async getCodeReviewConfigs(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ICodeReviewParameter> {
        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        return codeReviewConfig?.configValue;
    }

    private async getFormattedRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        return await this.integrationConfigService.findIntegrationConfigFormatted<
            ICodeRepository[]
        >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);
    }

    private filterRepositoryInfo(codeRepositories: ICodeRepository[]) {
        return codeRepositories.map((repository) => ({
            id: repository.id,
            name: repository.name,
            isSelected: false,
        }));
    }

    private async createNewConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        configValue: CodeReviewConfigWithoutLLMProvider,
        filteredRepositoryInfo: IFilteredCodeRepository[],
    ) {
        const updatedConfigValue = {
            global: {
                ...configValue,
                summary: !configValue.summary
                    ? this.getDefaultPRSummaryConfig()
                    : configValue.summary,
                suggestionControl: !configValue.suggestionControl
                    ? this.getDefaultSuggestionControlConfig()
                    : configValue.suggestionControl,
                isCommitMode: false, // By default, commit mode is disabled
            },
            repositories: filteredRepositoryInfo,
        };

        return await this.parametersService.createOrUpdateConfig(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedConfigValue,
            organizationAndTeamData,
        );
    }

    private updateExistingGlobalConfig(
        codeReviewConfigs: ICodeReviewParameter,
        filteredRepositoryInfo: IFilteredCodeRepository[],
    ) {
        if (!codeReviewConfigs.repositories) {
            codeReviewConfigs.repositories = filteredRepositoryInfo;
        }

        if (!codeReviewConfigs.global.summary) {
            codeReviewConfigs.global.summary = this.getDefaultPRSummaryConfig();
        }

        if (!codeReviewConfigs.global.suggestionControl) {
            codeReviewConfigs.global.suggestionControl =
                this.getDefaultSuggestionControlConfig();
        }

        this.mergeRepositories(codeReviewConfigs, filteredRepositoryInfo);
    }

    private mergeRepositories(
        codeReviewConfigs: ICodeReviewParameter,
        filteredRepositoryInfo: IFilteredCodeRepository[],
    ) {
        const existingRepoIds = new Set(
            codeReviewConfigs.repositories.map((repo) => repo.id),
        );
        const updatedRepositories = [
            ...codeReviewConfigs.repositories,
            ...filteredRepositoryInfo.filter(
                (repo) => !existingRepoIds.has(repo.id),
            ),
        ];

        codeReviewConfigs.repositories = updatedRepositories;
    }

    private async updateGlobalConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        codeReviewConfigs: ICodeReviewParameter,
        newGlobalInfo: CodeReviewConfigWithoutLLMProvider,
    ) {
        const updatedCodeReviewConfigValue = {
            global: {
                ...codeReviewConfigs.global,
                ...newGlobalInfo,
                summary: {
                    ...codeReviewConfigs.global.summary,
                    ...newGlobalInfo?.summary,
                },
                suggestionControl: {
                    ...codeReviewConfigs.global.suggestionControl,
                    ...newGlobalInfo?.suggestionControl,
                },
                isCommitMode: newGlobalInfo?.isCommitMode ?? codeReviewConfigs.global.isCommitMode, // Keep the existing value or use the new one if provided
            },
            repositories: codeReviewConfigs.repositories,
        };

        return await this.parametersService.createOrUpdateConfig(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedCodeReviewConfigValue,
            organizationAndTeamData,
        );
    }

    private async updateSpecificRepositoryConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        codeReviewConfigs: ICodeReviewParameter,
        repositoryId: string,
        configValue: CodeReviewConfigWithoutLLMProvider,
    ) {
        const updatedRepositories = codeReviewConfigs.repositories.map(
            (repository: any) => {
                if (repository.id === repositoryId) {
                    if (!repository.summary) {
                        return {
                            ...repository,
                            ...configValue,
                            summary: this.getDefaultPRSummaryConfig(),
                            isSelected: true,
                        };
                    }
                    return {
                        ...repository,
                        ...configValue,
                        summary: {
                            ...repository.summary,
                            ...configValue?.summary,
                        },
                        isSelected: true,
                    };
                }
                return repository;
            },
        );

        const updatedCodeReviewConfigValue = {
            repositories: updatedRepositories,
            global: codeReviewConfigs.global,
        };

        return await this.parametersService.createOrUpdateConfig(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedCodeReviewConfigValue,
            organizationAndTeamData,
        );
    }

    private handleError(error: any, body: Body) {
        this.logger.error({
            message:
                'Error creating or updating code review configuration parameter',
            context: UpdateOrCreateCodeReviewParameterUseCase.name,
            error: error,
            metadata: {
                parametersKey: ParametersKey.CODE_REVIEW_CONFIG,
                configValue: body.configValue,
                organizationAndTeamData: body.organizationAndTeamData,
            },
        });
    }
}
