import { Injectable, Inject } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { IGlobalParametersService, GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@/core/domain/global-parameters/contracts/global-parameters.service.contract';
import { GlobalParametersKey } from '@/shared/domain/enums/global-parameters-key.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { AuthorizationService } from '@/core/infrastructure/adapters/services/permissions/authorization.service';
import { Action, ResourceType } from '@/core/domain/permissions/enums/permissions.enum';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

@Injectable()
export class UpdateGlobalFineTuningConfigUseCase implements IUseCase {
    constructor(
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParametersService: IGlobalParametersService,
        private readonly authorizationService: AuthorizationService,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(params: {
        user: IUser;
        organizationAndTeamData: OrganizationAndTeamData;
        enabled: boolean;
    }): Promise<boolean> {
        const { user, organizationAndTeamData, enabled } = params;

        try {
            // Check if user has permission to manage organization settings
            await this.authorizationService.ensure({
                user,
                action: Action.Manage,
                resource: ResourceType.OrganizationSettings,
            });

            // Get current global fine-tuning configuration
            const currentConfig = await this.globalParametersService.findByKey(
                GlobalParametersKey.KODY_FINE_TUNING_CONFIG,
                organizationAndTeamData,
            );

            // Update or create the configuration
            const configValue = {
                enabled,
                ...(currentConfig?.configValue || {}),
            };

            await this.globalParametersService.createOrUpdateConfig(
                GlobalParametersKey.KODY_FINE_TUNING_CONFIG,
                configValue,
                organizationAndTeamData,
            );

            this.logger.info({
                message: 'Global fine-tuning configuration updated successfully',
                context: UpdateGlobalFineTuningConfigUseCase.name,
                metadata: {
                    enabled,
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });

            return true;
        } catch (error) {
            if (error instanceof ForbiddenException) {
                throw error;
            }

            this.logger.error({
                message: 'Error updating global fine-tuning configuration',
                context: UpdateGlobalFineTuningConfigUseCase.name,
                error: error.message,
                metadata: {
                    enabled,
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });

            throw new BadRequestException('Failed to update global fine-tuning configuration');
        }
    }
}
