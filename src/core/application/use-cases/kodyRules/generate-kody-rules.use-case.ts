import { CommentAnalysisService } from '@/core/infrastructure/adapters/services/codeBase/commentAnalysis.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { GenerateKodyRulesDTO } from '@/core/infrastructure/http/dtos/generate-kody-rules.dto';
import { Inject, Injectable } from '@nestjs/common';

import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import { KodyRulesStatus } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import { generateDateFilter } from '@/shared/utils/transforms/date';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { KodyLearningStatus } from '@/core/domain/parameters/types/configValue.type';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class GenerateKodyRulesUseCase {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly codeManagementService: CodeManagementService,

        private readonly commentAnalysisService: CommentAnalysisService,

        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,

        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(body: GenerateKodyRulesDTO, organizationId: string) {
        let platformConfig: ParametersEntity;
        let organizationAndTeamData: OrganizationAndTeamData;

        try {
            const { teamId, months, weeks, days, repositoriesIds = [] } = body;

            organizationAndTeamData = {
                organizationId,
                teamId,
            };

            const dateFilter = generateDateFilter({ months, weeks, days });

            const repositories = await this.getRepositories(
                organizationAndTeamData,
            );

            if (!repositories || repositories.length === 0) {
                this.logger.log({
                    message: 'No repositories found',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });

                return [];
            }

            const filteredRepositories =
                repositoriesIds.length > 0
                    ? repositories.filter((repo) =>
                          repositoriesIds.includes(repo.id),
                      )
                    : repositories;

            if (!filteredRepositories || filteredRepositories.length === 0) {
                this.logger.log({
                    message: 'No repositories found after filtering',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });

                return [];
            }

            const existingRules =
                await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                    organizationId,
                    {},
                );

            platformConfig = await this.parametersService.findByKey(
                ParametersKey.PLATFORM_CONFIGS,
                organizationAndTeamData,
            );

            if (!platformConfig || !platformConfig.configValue) {
                throw new Error('Platform config not found');
            }

            await this.parametersService.createOrUpdateConfig(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    kodyLearningStatus: KodyLearningStatus.GENERATING_RULES,
                },
                organizationAndTeamData,
            );

            const allRules = [];
            for (const repository of filteredRepositories) {
                const pullRequests =
                    await this.codeManagementService.getPullRequestsByRepository(
                        {
                            organizationAndTeamData,
                            repository,
                            filters: {
                                ...dateFilter,
                            },
                        },
                    );

                if (!pullRequests || pullRequests.length === 0) {
                    this.logger.log({
                        message: 'No pull requests found',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            dateFilter,
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                const comments = [];
                for (const pr of pullRequests) {
                    const generalComments =
                        await this.codeManagementService.getAllCommentsInPullRequest(
                            {
                                organizationAndTeamData,
                                repository,
                                prNumber: pr.pull_number,
                            },
                        );

                    const reviewComments =
                        await this.codeManagementService.getPullRequestReviewComment(
                            {
                                organizationAndTeamData,
                                filters: {
                                    repository,
                                    pullRequestNumber: pr.pull_number,
                                },
                            },
                        );

                    const files =
                        await this.codeManagementService.getFilesByPullRequestId(
                            {
                                organizationAndTeamData,
                                repository,
                                prNumber: pr.pull_number,
                            },
                        );

                    comments.push({
                        pr,
                        generalComments,
                        reviewComments,
                        files,
                    });
                }

                if (!comments || comments.length === 0) {
                    this.logger.log({
                        message: 'No comments found',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });

                    continue;
                }

                const processedComments =
                    this.commentAnalysisService.processComments(comments);

                if (!processedComments || processedComments.length === 0) {
                    continue;
                }

                const rules =
                    await this.commentAnalysisService.generateKodyRules({
                        comments: processedComments,
                        existingRules,
                    });

                if (!rules || rules.length === 0) {
                    this.logger.log({
                        message: 'No rules generated',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                for (const rule of rules) {
                    const dto: CreateKodyRuleDto = {
                        examples: rule.examples,
                        origin: rule.origin,
                        rule: rule.rule,
                        title: rule.title,
                        repositoryId: repository.id,
                        path: '',
                        status: KodyRulesStatus.PENDING,
                        severity: rule.severity as KodyRuleSeverity,
                    };

                    await this.createOrUpdateKodyRulesUseCase.execute(
                        dto,
                        organizationId,
                    );

                    this.logger.log({
                        message: 'Rule generated and saved successfully',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: { rule },
                    });
                }

                allRules.push(rules);
            }

            if (allRules.length === 0) {
                this.logger.log({
                    message: 'No rules generated',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });

                await this.parametersService.createOrUpdateConfig(
                    ParametersKey.PLATFORM_CONFIGS,
                    {
                        ...platformConfig.configValue,
                        kodyLearningStatus: KodyLearningStatus.DISABLED,
                    },
                    organizationAndTeamData,
                );

                return [];
            }

            await this.parametersService.createOrUpdateConfig(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    kodyLearningStatus: KodyLearningStatus.ENABLED,
                },
                organizationAndTeamData,
            );

            this.logger.log({
                message: 'Kody rules generated successfully',
                context: GenerateKodyRulesUseCase.name,
                metadata: { body, organizationAndTeamData },
            });

            return allRules.flat();
        } catch (error) {
            this.logger.error({
                message: 'Error generating kody rules',
                context: GenerateKodyRulesUseCase.name,
                error,
                metadata: body,
            });

            if (platformConfig) {
                await this.parametersService.createOrUpdateConfig(
                    ParametersKey.PLATFORM_CONFIGS,
                    {
                        ...platformConfig.configValue,
                        kodyLearningStatus: KodyLearningStatus.DISABLED,
                    },
                    organizationAndTeamData ?? { teamId: body.teamId },
                );
            }

            throw error;
        }
    }

    private async getRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        if (!codeReviewConfig || !codeReviewConfig.configValue)
            return this.getRepositoriesIntegration(organizationAndTeamData);

        return codeReviewConfig.configValue.repositories.filter(
            (repo) => repo.isSelected === true,
        ) as Repositories[];
    }

    private async getRepositoriesIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        if (!integration) {
            throw new Error('Integration not found');
        }

        const integrationConfig = await this.integrationConfigService.findOne({
            integration: { uuid: integration?.uuid },
            team: { uuid: organizationAndTeamData.teamId },
            configKey: IntegrationConfigKey.REPOSITORIES,
        });

        if (!integrationConfig) {
            throw new Error('Integration config not found');
        }

        return integrationConfig.configValue as Repositories[];
    }
}
