import { createLogger } from '@kodus/flow';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import {
    OrganizationParametersKey,
    ParametersKey,
} from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    LimitationType,
    ReviewCadenceType,
    ReviewPreset,
    SuggestionControlConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class ApplyCodeReviewPresetUseCase implements IUseCase {
    private readonly logger = createLogger(ApplyCodeReviewPresetUseCase.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,

        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,

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
            const centralizedConfig = await this.parametersService.findByKey(
                ParametersKey.CENTRALIZED_CONFIG,
                organizationAndTeamData,
            );

            if (centralizedConfig?.configValue?.enabled === true) {
                throw new ForbiddenException(
                    'Code review settings are locked while centralized configuration is enabled.',
                );
            }

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

            await this.createOrUpdateParametersUseCase.execute(
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
            if (error instanceof ForbiddenException) {
                throw error;
            }

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
                reviewOptions.performance = false;
                reviewOptions.cross_file = false;
                reviewOptions.business_logic = false;

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
                reviewOptions.performance = true;
                reviewOptions.cross_file = true;
                reviewOptions.business_logic = true;

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
                reviewOptions.performance = true;
                reviewOptions.cross_file = true;
                reviewOptions.business_logic = true;

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
