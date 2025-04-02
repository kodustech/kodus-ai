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
export class GetCheckinConfigUseCase implements IUseCase {
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
        checkinId: string, // Added checkinId as a parameter
    ): Promise<CheckinConfigValue[]> {
        try {
            const parametersKey = ParametersKey.CHECKIN_CONFIG;
            const parameters = await this.parametersService.findByKey(
                parametersKey,
                {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: this.request.user.organization.uuid,
                },
            );

            if (!parameters) {
                return [];
            } else {
                return parameters.configValue.find(
                    (config) => config.checkinId === checkinId,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error fetching checkin configurations',
                context: GetCheckinConfigUseCase.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                },
            });
            throw error;
        }
    }
}
