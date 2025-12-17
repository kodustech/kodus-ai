import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    ReviewCadenceType,
    ReviewPreset,
    LimitationType,
    SuggestionControlConfig,
} from '@/config/types/general/codeReview.type';
import { CodeReviewParameter } from '@/config/types/general/codeReviewConfig.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { UserRequest } from '@/config/types/http/user-request.type';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { getDefaultKodusConfigFile } from '@/shared/utils/validateCodeReviewConfigFile';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

@Injectable()
export class ApplyCodeReviewPresetUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,

        private readonly logger: PinoLoggerService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    async execute(params: {
        teamId: string;
        preset: ReviewPreset;
        organizationId?: string;
        organizationAndTeamData?: OrganizationAndTeamData;
    }) {
        const organizationId =
            this.request?.user?.organization?.uuid ||
            params?.['organizationId'] ||
            params?.['organizationAndTeamData']?.organizationId;

        if (!organizationId) {
            throw new Error('Organization ID not found');
        }

        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
            teamId: params.teamId,
        };

        try {
            const existing = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            const baseConfig =
                (existing?.configValue as any as CodeReviewParameter) ||
                ({
                    id: 'global',
                    name: 'Global',
                    isSelected: true,
                    configs: getDefaultKodusConfigFile(),
                    repositories: [],
                } as CodeReviewParameter);

            const updatedConfig = this.applyPreset(baseConfig, params.preset);

            await this.parametersService.createOrUpdateConfig(
                ParametersKey.CODE_REVIEW_CONFIG,
                updatedConfig,
                organizationAndTeamData,
            );

            await this.organizationParametersService.createOrUpdateConfig(
                OrganizationParametersKey.CODE_REVIEW_PRESET,
                {
                    preset: params.preset,
                    teamId: params.teamId,
                    updatedAt: new Date().toISOString(),
                },
                organizationAndTeamData,
            );

            return updatedConfig;
        } catch (error) {
            this.logger.error({
                message: 'Failed to apply code review preset',
                context: ApplyCodeReviewPresetUseCase.name,
                error,
                metadata: {
                    params,
                    organizationAndTeamData,
                },
            });
            throw error;
        }
    }

    private applyPreset(
        baseConfig: CodeReviewParameter,
        preset: ReviewPreset,
    ): CodeReviewParameter {
        const reviewOptions = { ...(baseConfig.configs.reviewOptions || {}) };
        const suggestionControl: SuggestionControlConfig = {
            ...(baseConfig.configs.suggestionControl || ({} as any)),
        } as SuggestionControlConfig;
        const v2PromptOverrides = {
            ...(baseConfig.configs.v2PromptOverrides || {}),
        };

        switch (preset) {
            case ReviewPreset.SPEED: {
                reviewOptions.bug = true;
                reviewOptions.security = true;
                reviewOptions.breaking_changes = true;
                reviewOptions.performance = false;
                reviewOptions.cross_file = false;
                reviewOptions.performance_and_optimization = false;
                reviewOptions.kody_rules = true;

                suggestionControl.limitationType = LimitationType.PR;
                suggestionControl.maxSuggestions = 6;
                suggestionControl.severityLevelFilter = SeverityLevel.CRITICAL;
                suggestionControl.applyFiltersToKodyRules = true;

                baseConfig.configs.reviewCadence = {
                    type: ReviewCadenceType.MANUAL,
                };
                baseConfig.configs.runOnDraft = false;
                break;
            }

            case ReviewPreset.SAFETY: {
                Object.keys(reviewOptions).forEach((key) => {
                    (reviewOptions as any)[key] = true;
                });
                reviewOptions.bug = true;
                reviewOptions.security = true;
                reviewOptions.breaking_changes = true;
                reviewOptions.performance = true;
                reviewOptions.cross_file = true;
                reviewOptions.performance_and_optimization = true;
                reviewOptions.kody_rules = true;
                reviewOptions.error_handling = true;
                reviewOptions.maintainability = true;
                reviewOptions.potential_issues = true;
                reviewOptions.documentation_and_comments = true;
                reviewOptions.refactoring = true;
                reviewOptions.code_style = true;

                suggestionControl.limitationType = LimitationType.PR;
                suggestionControl.maxSuggestions = 20;
                suggestionControl.severityLevelFilter = SeverityLevel.MEDIUM;
                suggestionControl.applyFiltersToKodyRules = false;

                baseConfig.configs.reviewCadence = {
                    type: ReviewCadenceType.AUTOMATIC,
                };
                baseConfig.configs.runOnDraft = false;
                break;
            }

            case ReviewPreset.COACH: {
                reviewOptions.bug = true;
                reviewOptions.security = true;
                reviewOptions.breaking_changes = true;
                reviewOptions.performance = true;
                reviewOptions.cross_file = true;
                reviewOptions.performance_and_optimization = true;
                reviewOptions.kody_rules = true;

                suggestionControl.limitationType = LimitationType.PR;
                suggestionControl.maxSuggestions = 12;
                suggestionControl.severityLevelFilter = SeverityLevel.MEDIUM;
                suggestionControl.applyFiltersToKodyRules = false;

                baseConfig.configs.reviewCadence = {
                    type: ReviewCadenceType.AUTOMATIC,
                };
                baseConfig.configs.runOnDraft = true;

                v2PromptOverrides.generation = {
                    ...v2PromptOverrides.generation,
                    main: [
                        'Adopt a coaching tone:',
                        '- Explain briefly the why behind each issue.',
                        '- Suggest how to validate (tests/checks).',
                        '- Prefer concise examples.',
                        '- Avoid nitpicks and group by priority.',
                    ].join(' '),
                };
                break;
            }
        }

        return {
            ...baseConfig,
            configs: {
                ...baseConfig.configs,
                automatedReviewActive: true,
                reviewOptions,
                suggestionControl: suggestionControl as any,
                v2PromptOverrides,
            },
        };
    }
}
