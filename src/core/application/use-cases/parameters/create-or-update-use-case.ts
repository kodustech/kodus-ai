import { Inject, Injectable } from '@nestjs/common';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

@Injectable()
export class CreateOrUpdateParametersUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(
        parametersKey: ParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity | boolean> {
        try {
            return await this.parametersService.createOrUpdateConfig(
                parametersKey,
                configValue,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error creating or updating parameters',
                context: CreateOrUpdateParametersUseCase.name,
                error: error,
                metadata: {
                    parametersKey,
                    configValue,
                    organizationAndTeamData,
                },
            });
            throw new Error('Error creating or updating parameters');
        }
    }
}
