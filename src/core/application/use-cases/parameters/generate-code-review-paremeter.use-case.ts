import { CommentAnalysisService } from '@/core/infrastructure/adapters/services/codeBase/commentAnalysis.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { GenerateCodeReviewParameterDTO } from '@/core/infrastructure/http/dtos/generate-code-review-parameter.dto';
import { Injectable, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { UpdateOrCreateCodeReviewParameterUseCase } from './update-or-create-code-review-parameter-use-case';
import { generateDateFilter } from '@/shared/utils/transforms/date';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { KodyLearningStatus } from '@/core/domain/parameters/types/configValue.type';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
@Injectable()
export class GenerateCodeReviewParameterUseCase {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly codeManagementService: CodeManagementService,

        private readonly commentAnalysisService: CommentAnalysisService,

        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,

        private readonly logger: PinoLoggerService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(body: GenerateCodeReviewParameterDTO) {
        let platformConfig: ParametersEntity;
        let organizationAndTeamData: OrganizationAndTeamData;

        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }
            const { teamId, alignmentLevel, months, weeks, days } = body;

            organizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
                teamId,
            };

            const dateFilter = generateDateFilter({ months, weeks, days });

            const repositories = await this.getRepositoriesIntegration(
                organizationAndTeamData,
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
                    kodyLearningStatus: KodyLearningStatus.GENERATING_CONFIG,
                },
                organizationAndTeamData,
            );

            const generatedConfigs = [];
            for (const repository of repositories) {
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
                        context: GenerateCodeReviewParameterUseCase.name,
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

                    comments.push({
                        pr,
                        generalComments,
                        reviewComments,
                    });
                }

                if (!comments || comments.length === 0) {
                    this.logger.log({
                        message: 'No comments found',
                        context: GenerateCodeReviewParameterUseCase.name,
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

                const categorizedComments =
                    await this.commentAnalysisService.categorizeComments({
                        comments: processedComments,
                    });

                if (!categorizedComments || categorizedComments.length === 0) {
                    this.logger.log({
                        message: 'No categorized comments found',
                        context: GenerateCodeReviewParameterUseCase.name,
                        metadata: {
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                const generated =
                    await this.commentAnalysisService.generateCodeReviewParameters(
                        {
                            comments: categorizedComments,
                            alignmentLevel: body.alignmentLevel,
                        },
                    );

                if (!generated) {
                    this.logger.log({
                        message: 'No generated config found',
                        context: GenerateCodeReviewParameterUseCase.name,
                        metadata: {
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                await this.updateOrCreateCodeReviewParameterUseCase.execute({
                    organizationAndTeamData,
                    configValue: generated,
                    repositoryId: repository.id,
                });

                generatedConfigs.push({
                    repositoryId: repository.id,
                    comments: categorizedComments,
                });
            }

            const allComments = generatedConfigs.flatMap(
                (config) => config.comments,
            );

            if (!allComments || allComments.length === 0) {
                this.logger.log({
                    message: 'No comments found for generating global config',
                    context: GenerateCodeReviewParameterUseCase.name,
                    metadata: {
                        repositories: repositories.map((repo) => repo.id),
                    },
                });

                await this.parametersService.createOrUpdateConfig(
                    ParametersKey.PLATFORM_CONFIGS,
                    {
                        ...platformConfig.configValue,
                        kodyLearningStatus: KodyLearningStatus.DISABLED,
                    },
                    organizationAndTeamData,
                );

                return;
            }

            const globalConfig =
                await this.commentAnalysisService.generateCodeReviewParameters({
                    comments: allComments,
                    alignmentLevel,
                });

            await this.parametersService.createOrUpdateConfig(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    kodyLearningStatus: KodyLearningStatus.ENABLED,
                },
                organizationAndTeamData,
            );

            return await this.updateOrCreateCodeReviewParameterUseCase.execute({
                organizationAndTeamData,
                configValue: globalConfig,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error generating code review parameter',
                context: GenerateCodeReviewParameterUseCase.name,
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
