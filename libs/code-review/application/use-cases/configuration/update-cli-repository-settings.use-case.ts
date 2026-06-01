import { Inject, Injectable } from '@nestjs/common';

import { CentralizedPrMetadata } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    RepositoryCodeReviewConfig,
    CodeReviewParameter,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { UpdateOrCreateCodeReviewParameterUseCase } from './update-or-create-code-review-parameter-use-case';
import { CliRepositorySettings } from './cli-repository-settings.types';

@Injectable()
export class UpdateCliRepositorySettingsUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,
    ) {}

    async execute(params: {
        repositoryId: string;
        organizationAndTeamData: OrganizationAndTeamData;
        settings: CliRepositorySettings;
    }): Promise<CliRepositorySettings | CentralizedPrMetadata> {
        const parameter = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            params.organizationAndTeamData,
        );
        const repositoryConfig = this.findRepositoryConfig(
            parameter?.configValue,
            params.repositoryId,
        );

        const result =
            await this.updateOrCreateCodeReviewParameterUseCase.execute({
                actor: {
                    source: 'cli',
                },
                configValue: {
                    automatedReviewActive: params.settings.reviewEnabled,
                    pullRequestApprovalActive:
                        params.settings.autoApproveEnabled,
                    ignorePaths: params.settings.ignoredFilePatterns,
                    baseBranches: params.settings.baseBranchPatterns,
                    ignoredTitleKeywords: params.settings.ignoredTitlePatterns,
                    suggestionControl: {
                        ...(repositoryConfig?.configs?.suggestionControl ?? {}),
                        severityLevelFilter: this.toSuggestionSeverity(
                            params.settings.requestChangesMinSeverity,
                        ),
                    },
                },
                organizationAndTeamData: params.organizationAndTeamData,
                repositoryId: params.repositoryId,
                skipAuthorization: true,
            } as any);

        if (
            result &&
            typeof result === 'object' &&
            'mode' in result &&
            result.mode === 'centralized-pr'
        ) {
            return result as CentralizedPrMetadata;
        }

        return params.settings;
    }

    private findRepositoryConfig(
        configValue: CodeReviewParameter | undefined,
        repositoryId: string,
    ): RepositoryCodeReviewConfig | undefined {
        return configValue?.repositories?.find(
            (repository) => repository.id === repositoryId,
        );
    }

    private toSuggestionSeverity(
        value: CliRepositorySettings['requestChangesMinSeverity'],
    ): 'low' | 'medium' | 'high' | 'critical' {
        switch (value) {
            case 'critical':
                return 'critical';
            case 'high':
                return 'high';
            case 'medium':
                return 'medium';
            case 'low':
            default:
                return 'low';
        }
    }
}
