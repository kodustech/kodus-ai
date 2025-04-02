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

interface Body {
    organizationAndTeamData: OrganizationAndTeamData;
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

@Injectable()
export class UpdateCodeReviewParameterRepositoriesUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(body: Body): Promise<ParametersEntity | boolean> {
        try {
            const { organizationAndTeamData } = body;

            const codeReviewConfigs = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            if (!codeReviewConfigs) {
                return false;
            }

            const codeRepositories =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ICodeRepository[]
                >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

            const filteredRepositories = codeRepositories.map((repository) => {
                return {
                    id: repository.id,
                    name: repository.name,
                };
            });

            const codeReviewRepositories =
                codeReviewConfigs.configValue.repositories;

            const commonRepositories = codeReviewRepositories.filter(
                (repository) =>
                    filteredRepositories.some(
                        (filteredRepo) => filteredRepo.id === repository.id,
                    ),
            );

            const codeReviewRepositoryIds = codeReviewRepositories.map(
                (repo) => repo.id,
            );

            const newRepositories = filteredRepositories.filter(
                (repository) =>
                    !codeReviewRepositoryIds.includes(repository.id),
            );

            const updatedRepositories = Array.from(
                new Map(
                    [...commonRepositories, ...newRepositories].map((repo) => [
                        repo.id,
                        repo,
                    ]),
                ).values(),
            );
            const updatedCodeReviewConfigValue = {
                ...codeReviewConfigs.configValue,
                repositories: updatedRepositories,
            };

            return await this.parametersService.createOrUpdateConfig(
                ParametersKey.CODE_REVIEW_CONFIG,
                updatedCodeReviewConfigValue,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error creating or updating code review parameter repositories',
                context: UpdateCodeReviewParameterRepositoriesUseCase.name,
                error: error,
                metadata: {
                    parametersKey: ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData: body.organizationAndTeamData,
                },
            });
            throw new Error('Error creating or updating parameters');
        }
    }
}
