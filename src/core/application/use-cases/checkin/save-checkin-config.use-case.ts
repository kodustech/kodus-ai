import { Inject, Injectable } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { CheckinConfigValue } from '@/core/domain/parameters/types/configValue.type';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { REQUEST } from '@nestjs/core';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

@Injectable()
export class SaveCheckinConfigUseCase implements IUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        checkinConfig: CheckinConfigValue,
    ): Promise<void> {
        try {
            const parametersKey = ParametersKey.CHECKIN_CONFIG;
            const parameters = await this.parametersService.findByKey(
                parametersKey,
                {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: this.request.user.organization.uuid,
                },
            );

            const configValue = parameters?.configValue || [];

            if (!parameters) {
                // No configuration in the database
                await this.parametersService.createOrUpdateConfig(
                    parametersKey,
                    [checkinConfig],
                    organizationAndTeamData,
                );
            } else {
                const index = configValue.findIndex(
                    (el) => el.checkinId === checkinConfig.checkinId,
                );

                if (index === -1) {
                    // Object exists in the database, but without the check-in
                    configValue.push(checkinConfig); // Adds new configuration
                } else {
                    // Object and check-in already exist
                    configValue[index] = checkinConfig; // Updates existing configuration
                }

                // Updates the configuration in the database
                await this.parametersService.createOrUpdateConfig(
                    parametersKey,
                    configValue,
                    {
                        teamId: organizationAndTeamData.teamId,
                        organizationId: this.request.user.organization.uuid,
                    },
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error saving check-in configurations',
                context: SaveCheckinConfigUseCase.name,
                error: error,
                metadata: {
                    checkinId: checkinConfig.checkinId,
                    teamId: organizationAndTeamData.teamId,
                },
            });
        }
    }
}
