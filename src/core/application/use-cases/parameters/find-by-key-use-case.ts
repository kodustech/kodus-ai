import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IParameters } from '@/core/domain/parameters/interfaces/parameters.interface';
import { artifacts as teamArtifacts } from '@/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json';
import { organizationArtifacts } from '@/core/infrastructure/adapters/services/organizationArtifacts/organizationArtifactsStructure.json';

@Injectable()
export class FindByKeyParametersUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(
        parametersKey: ParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IParameters> {
        try {
            const parameter = await this.parametersService.findByKey(
                parametersKey,
                organizationAndTeamData,
            );

            if (!parameter) {
                throw new NotFoundException('Parameter config does not exist');
            }

            const updatedParameters = this.getUpdatedParamaters(parameter);

            return updatedParameters;
        } catch (error) {
            this.logger.error({
                message: 'Error while fetching parameters by key',
                context: FindByKeyParametersUseCase.name,
                error: error,
                metadata: { parametersKey, organizationAndTeamData },
            });

            throw error;
        }
    }

    private getUpdatedParamaters(parameter: ParametersEntity) {
        if (parameter.configKey === ParametersKey.TEAM_ARTIFACTS_CONFIG) {
            const response = {
                configKey: parameter.configKey,
                configValue: parameter.configValue.map((config) => ({
                    ...config,
                    description:
                        teamArtifacts.find(
                            (artifact) => artifact.name === config.name,
                        )?.whyIsImportant || '',
                })),
                team: parameter.team,
                uuid: parameter.uuid,
            };

            return response;
        } else if (
            parameter.configKey == ParametersKey.ORGANIZATION_ARTIFACTS_CONFIG
        ) {
            const response = {
                configKey: parameter.configKey,
                configValue: parameter.configValue.map((config) => ({
                    ...config,
                    description:
                        organizationArtifacts.find(
                            (artifact) => artifact.name === config.name,
                        )?.whyIsImportant || '',
                })),
                team: parameter.team,
                uuid: parameter.uuid,
            };

            return response;
        } else {
            return {
                configKey: parameter.configKey,
                configValue: parameter.configValue,
                team: parameter.team,
                uuid: parameter.uuid,
            };
        }
    }
}
