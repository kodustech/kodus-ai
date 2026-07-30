import { ForbiddenException, Injectable } from '@nestjs/common';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    FormattedGlobalCodeReviewConfig,
    IFormattedConfigProperty,
    RepositoryCodeReviewConfig,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { UpdateCodeReviewParameterRepositoriesUseCase } from './update-code-review-parameter-repositories-use-case';
import {
    CliRepositorySettings,
    CliRepositorySettingsLevel,
    CliRepositorySettingsSource,
} from './cli-repository-settings.types';
import { GetCodeReviewParameterUseCase } from './get-code-review-parameter.use-case';

@Injectable()
export class GetCliRepositorySettingsUseCase {
    constructor(
        private readonly updateCodeReviewParameterRepositoriesUseCase: UpdateCodeReviewParameterRepositoriesUseCase,
        private readonly getCodeReviewParameterUseCase: GetCodeReviewParameterUseCase,
    ) {}

    async execute(params: {
        repositoryId: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<CliRepositorySettings | null> {
        let config = await this.getFormattedConfig(
            params.organizationAndTeamData,
        );
        let repositoryConfig = this.findRepositoryConfig(
            config,
            params.repositoryId,
        );

        if (repositoryConfig) {
            return this.toCliRepositorySettings(repositoryConfig);
        }

        try {
            await this.updateCodeReviewParameterRepositoriesUseCase.execute({
                actor: {
                    organizationId:
                        params.organizationAndTeamData.organizationId,
                    source: 'cli',
                },
                organizationAndTeamData: params.organizationAndTeamData,
            });
        } catch (error) {
            if (!(error instanceof ForbiddenException)) {
                throw error;
            }
        }

        config = await this.getFormattedConfig(params.organizationAndTeamData);
        repositoryConfig = this.findRepositoryConfig(
            config,
            params.repositoryId,
        );

        if (!repositoryConfig) {
            return null;
        }

        return this.toCliRepositorySettings(repositoryConfig);
    }

    private async getFormattedConfig(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<FormattedGlobalCodeReviewConfig> {
        const response = await this.getCodeReviewParameterUseCase.execute(
            {
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
            } as any,
            organizationAndTeamData.teamId,
            {
                skipAuthorization: true,
                organizationId: organizationAndTeamData.organizationId,
            },
        );

        return response.configValue;
    }

    private findRepositoryConfig(
        configValue: FormattedGlobalCodeReviewConfig | undefined,
        repositoryId: string,
    ) {
        return configValue?.repositories?.find(
            (repository) => repository.id === repositoryId,
        );
    }

    private toCliRepositorySettings(
        repository: RepositoryCodeReviewConfig,
    ): CliRepositorySettings {
        const severityLevelFilter =
            repository.configs?.suggestionControl?.severityLevelFilter;

        return {
            reviewEnabled:
                repository.configs?.automatedReviewActive?.value ?? false,
            autoApproveEnabled:
                repository.configs?.pullRequestApprovalActive?.value ?? false,
            requestChangesMinSeverity:
                severityLevelFilter?.value === 'critical' ||
                severityLevelFilter?.value === 'high' ||
                severityLevelFilter?.value === 'medium' ||
                severityLevelFilter?.value === 'low'
                    ? severityLevelFilter.value
                    : 'low',
            ignoredFilePatterns: repository.configs?.ignorePaths?.value ?? [],
            baseBranchPatterns: repository.configs?.baseBranches?.value ?? [],
            ignoredTitlePatterns:
                repository.configs?.ignoredTitleKeywords?.value ?? [],
            sources: {
                reviewEnabled: this.toSource(
                    repository.configs?.automatedReviewActive,
                ),
                autoApproveEnabled: this.toSource(
                    repository.configs?.pullRequestApprovalActive,
                ),
                requestChangesMinSeverity: this.toSource(severityLevelFilter),
                ignoredFilePatterns: this.toSource(
                    repository.configs?.ignorePaths,
                ),
                baseBranchPatterns: this.toSource(
                    repository.configs?.baseBranches,
                ),
                ignoredTitlePatterns: this.toSource(
                    repository.configs?.ignoredTitleKeywords,
                ),
            },
        };
    }

    private toSource(
        property?: IFormattedConfigProperty<unknown>,
    ): CliRepositorySettingsSource {
        return {
            level: (property?.level ?? 'default') as CliRepositorySettingsLevel,
            overriddenLevel: property?.overriddenLevel as
                | CliRepositorySettingsLevel
                | undefined,
        };
    }
}
