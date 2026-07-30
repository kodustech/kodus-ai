import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import {
    ICodeRepository,
    CodeReviewParameter,
    RepositoryCodeReviewConfig,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    IKodyRule,
    KodyRulesOrigin,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

@Injectable()
export class CheckSyncStatusUseCase {
    private readonly logger = createLogger(CheckSyncStatusUseCase.name);
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(
        teamId: string,
        repositoryId?: string,
    ): Promise<{
        ideRulesSyncEnabledFirstTime: boolean;
        kodyRulesGeneratorEnabledFirstTime: boolean;
    }> {
        const syncStatusFlags = {
            ideRulesSyncEnabledFirstTime: true,
            kodyRulesGeneratorEnabledFirstTime: true,
        };

        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId: teamId,
        };

        try {
            const codeReviewConfigs: CodeReviewParameter =
                await this.getCodeReviewConfigs(organizationAndTeamData);

            const currentRepositoryConfig = codeReviewConfigs.repositories.find(
                (repository: RepositoryCodeReviewConfig) =>
                    repository.id === repositoryId,
            ) as RepositoryCodeReviewConfig;

            // Se não encontrou o repositório, retorna configuração padrão
            if (!currentRepositoryConfig) {
                return syncStatusFlags;
            }

            const rules =
                await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                    organizationAndTeamData.organizationId,
                    {},
                    repositoryId,
                );

            const ideRulesSyncEnabled =
                currentRepositoryConfig.configs.ideRulesSyncEnabled;

            if (!ideRulesSyncEnabled) {
                const ideRules = rules?.find((rule) =>
                    rule?.rules?.find((r: IKodyRule) => r.sourcePath),
                );

                syncStatusFlags.ideRulesSyncEnabledFirstTime = !ideRules;
            }

            // "First time" for the generator means the repo has never been
            // seeded from past reviews. It drives the one-time onboarding
            // notice; the current toggle value and platform learning status are
            // irrelevant to that fact (issue #1506 — the old logic returned the
            // pre-toggle value, so it was false exactly when it should be true).
            const hasPastReviewRules = rules?.some((rule) =>
                rule?.rules?.some(
                    (r: IKodyRule) =>
                        r.origin === KodyRulesOrigin.PAST_REVIEWS,
                ),
            );

            syncStatusFlags.kodyRulesGeneratorEnabledFirstTime =
                !hasPastReviewRules;

            return syncStatusFlags;
        } catch (error) {
            this.logger.error({
                message: 'Error checking sync status',
                error,
                context: CheckSyncStatusUseCase.name,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                    teamId,
                    repositoryId,
                },
            });

            return syncStatusFlags;
        }
    }

    private async getCodeReviewConfigs(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CodeReviewParameter> {
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
}
