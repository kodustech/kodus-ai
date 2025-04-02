import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    PARAMETERS_SERVICE_TOKEN,
    IParametersService,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CopyCodeReviewParameterDTO } from '@/core/infrastructure/http/dtos/copy-code-review-parameter.dto';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class CopyCodeReviewParameterUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly logger: PinoLoggerService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(body: CopyCodeReviewParameterDTO) {
        const { sourceRepositoryId, targetRepositoryId, teamId } = body;

        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
                teamId: teamId,
            };

            const codeReviewConfig = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            if (!codeReviewConfig) {
                throw new Error('Code review config not found');
            }

            const codeReviewConfigValue = codeReviewConfig.configValue;

            const sourceRepository =
                sourceRepositoryId === 'global'
                    ? codeReviewConfigValue.global
                    : codeReviewConfigValue.repositories.find(
                          (repository) => repository.id === sourceRepositoryId,
                      );

            const targetRepository = codeReviewConfigValue.repositories.find(
                (repository) => repository.id === targetRepositoryId,
            );

            if (!sourceRepository || !targetRepository) {
                throw new Error('Source or target repository not found');
            }

            const updatedTarget = {
                ...sourceRepository,
                id: targetRepository.id,
                name: targetRepository.name,
                isSelected: true,
            };

            const updatedRepositories = codeReviewConfigValue.repositories.map(
                (repository) =>
                    repository.id === targetRepositoryId
                        ? updatedTarget
                        : repository,
            );

            const updatedConfigValue = {
                ...codeReviewConfigValue,
                repositories: updatedRepositories,
            };

            const updated = await this.parametersService.createOrUpdateConfig(
                ParametersKey.CODE_REVIEW_CONFIG,
                updatedConfigValue,
                organizationAndTeamData,
            );

            this.logger.log({
                message: 'Code review parameter copied successfully',
                context: CopyCodeReviewParameterUseCase.name,
                serviceName: 'CopyCodeReviewParameterUseCase',
                metadata: {
                    body,
                    organizationAndTeamData,
                },
            });

            return updated;
        } catch (error) {
            this.logger.error({
                message: 'Could not copy code review parameter',
                context: CopyCodeReviewParameterUseCase.name,
                serviceName: 'CopyCodeReviewParameterUseCase',
                error: error,
                metadata: {
                    body,
                    organizationAndTeamData: {
                        organizationId: this.request.user.organization.uuid,
                        teamId: teamId,
                    },
                },
            });
            throw error;
        }
    }
}
