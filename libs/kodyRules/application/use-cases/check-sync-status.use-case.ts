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
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { ONBOARDING_IMPORT_REMOVED_REASON } from '@libs/core/infrastructure/database/mongo/kody-rules/freeze-agent-file-rules';
import { CacheService } from '@libs/core/cache/cache.service';

const GENERATOR_FLAG_TTL_MS = 15 * 60 * 1000;

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
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
        private readonly cacheService: CacheService,
    ) {}

    async execute(
        teamId: string,
        repositoryId?: string,
    ): Promise<{
        kodyRulesGeneratorEnabledFirstTime: boolean;
        removedOnboardingImports: number;
    }> {
        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId: teamId,
        };

        // Read on every call: a restore runs outside the API and could not
        // clear a cached count.
        const removedOnboardingImports =
            await this.countRemovedOnboardingImports(
                organizationAndTeamData.organizationId,
            );

        const cacheKey = `check-sync-status:${organizationAndTeamData.organizationId}:${teamId}:${repositoryId || 'no-repo'}`;
        const cached = await this.cacheService.getFromCache<{
            kodyRulesGeneratorEnabledFirstTime: boolean;
        }>(cacheKey);
        if (cached) {
            return {
                kodyRulesGeneratorEnabledFirstTime:
                    cached.kodyRulesGeneratorEnabledFirstTime,
                removedOnboardingImports,
            };
        }

        const kodyRulesGeneratorEnabledFirstTime =
            await this.generatorEnabledFirstTime(
                organizationAndTeamData,
                teamId,
                repositoryId,
            );
        await this.cacheService.addToCache(
            cacheKey,
            { kodyRulesGeneratorEnabledFirstTime },
            GENERATOR_FLAG_TTL_MS,
        );

        return { kodyRulesGeneratorEnabledFirstTime, removedOnboardingImports };
    }

    private async generatorEnabledFirstTime(
        organizationAndTeamData: OrganizationAndTeamData,
        teamId: string,
        repositoryId?: string,
    ): Promise<boolean> {
        try {
            const codeReviewConfigs: CodeReviewParameter =
                await this.getCodeReviewConfigs(organizationAndTeamData);

            const currentRepositoryConfig = codeReviewConfigs.repositories.find(
                (repository: RepositoryCodeReviewConfig) =>
                    repository.id === repositoryId,
            ) as RepositoryCodeReviewConfig;

            // Se não encontrou o repositório, retorna configuração padrão
            if (!currentRepositoryConfig) {
                return true;
            }

            const rules =
                await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                    organizationAndTeamData.organizationId,
                    {},
                    repositoryId,
                );

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

            return !hasPastReviewRules;
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

            return true;
        }
    }

    /**
     * Rules the onboarding import made from coding-agent files that the
     * agent-file migration removed. Drives the notice that offers the
     * coding-agent instructions setting instead.
     */
    private async countRemovedOnboardingImports(
        organizationId: string,
    ): Promise<number> {
        try {
            const doc =
                await this.kodyRulesService.findByOrganizationId(
                    organizationId,
                );
            return (doc?.rules ?? []).filter(
                (rule) =>
                    rule?.status === KodyRulesStatus.DELETED &&
                    rule?.reason === ONBOARDING_IMPORT_REMOVED_REASON,
            ).length;
        } catch (error) {
            this.logger.warn({
                message: 'Could not count removed onboarding imports',
                context: CheckSyncStatusUseCase.name,
                error,
                metadata: { organizationId },
            });
            return 0;
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
