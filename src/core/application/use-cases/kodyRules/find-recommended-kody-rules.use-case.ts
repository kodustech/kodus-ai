import { LibraryKodyRule } from '@/config/types/kodyRules.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    KODY_RULES_SERVICE_TOKEN,
    IKodyRulesService,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class FindRecommendedKodyRulesUseCase {
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        limit: number = 10,
    ): Promise<LibraryKodyRule[]> {
        try {
            const mcpRules = await this.kodyRulesService.getRecommendedRulesByMCP(
                organizationAndTeamData,
            );

            let repositories: any[] = [];
            try {
                repositories = await this.integrationConfigService.findIntegrationConfigFormatted<any[]>(
                    IntegrationConfigKey.REPOSITORIES,
                    organizationAndTeamData,
                );
            } catch (error) {
                this.logger.warn({
                    message: 'Failed to fetch repositories for recommendations',
                    context: FindRecommendedKodyRulesUseCase.name,
                    error,
                });
            }

            if (!Array.isArray(repositories)) {
                repositories = [];
            }

            const selectedRepos = repositories.filter((repo) => repo.selected);

            const suggestionRulesPromises = selectedRepos.map((repo) =>
                this.kodyRulesService
                    .getRecommendedRulesBySuggestions(
                        organizationAndTeamData,
                        repo.id,
                        repo.language || '',
                    )
                    .catch((error) => {
                        this.logger.warn({
                            message: 'Failed to get suggestions for repository',
                            context: FindRecommendedKodyRulesUseCase.name,
                            error,
                            metadata: { repositoryId: repo.id },
                        });
                        return [];
                    }),
            );

            const allSuggestionRules = await Promise.all(suggestionRulesPromises);
            const flattenedSuggestionRules = allSuggestionRules.flat();

            const combinedRules = [...mcpRules, ...flattenedSuggestionRules];

            const uniqueRulesMap = new Map<string, LibraryKodyRule>();
            combinedRules.forEach((rule) => {
                if (!uniqueRulesMap.has(rule.uuid)) {
                    uniqueRulesMap.set(rule.uuid, rule);
                }
            });

            const uniqueRules = Array.from(uniqueRulesMap.values());

            const limitedRules = uniqueRules.slice(0, limit);

            this.logger.log({
                message: 'Successfully retrieved recommended Kody Rules',
                context: FindRecommendedKodyRulesUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    repositoriesAnalyzed: selectedRepos.length,
                    mcpRulesCount: mcpRules.length,
                    suggestionRulesCount: flattenedSuggestionRules.length,
                    totalUniqueRules: uniqueRules.length,
                    returnedRules: limitedRules.length,
                },
            });

            return limitedRules;
        } catch (error) {
            this.logger.error({
                message: 'Error finding recommended Kody Rules',
                context: FindRecommendedKodyRulesUseCase.name,
                error: error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }
}
