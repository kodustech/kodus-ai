import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import {
    toIntegrationCategory,
    toPlatformType,
} from '@/shared/utils/enum-utils';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { or } from 'ramda';
import { v4 as uuidv4 } from 'uuid';

export class CloneIntegrationUseCase implements IUseCase {
    constructor(
        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
    ) {}
    public async execute(params: any): Promise<{ status: boolean }> {
        try {
            const organizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
                teamId: params.teamId,
            };

            const organizationAndTeamDataClone = {
                organizationId: this.request.user.organization.uuid,
                teamId: params.teamIdClone,
            };

            const platformType = toPlatformType(
                params.integrationData.platform,
            );
            const integrationCategory = toIntegrationCategory(
                params.integrationData.category,
            );

            const integrationDataClone = await this.integrationService.findOne({
                organization: {
                    uuid: organizationAndTeamDataClone.organizationId,
                },
                team: { uuid: organizationAndTeamDataClone.teamId },
                status: true,
                platform: platformType,
                integrationCategory: integrationCategory,
            });

            const authIntegrationDataClone =
                await this.authIntegrationService.findOne({
                    organization: {
                        uuid: organizationAndTeamDataClone.organizationId,
                    },
                    team: { uuid: organizationAndTeamDataClone.teamId },
                    status: true,
                    uuid: integrationDataClone?.authIntegration?.uuid,
                });

            const authUuid = uuidv4();

            const authIntegration = await this.authIntegrationService.create({
                uuid: authUuid,
                status: true,
                authDetails: authIntegrationDataClone.authDetails,
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
            });

            const integrationUuid = uuidv4();

            await this.integrationService.create({
                uuid: integrationUuid,
                platform: platformType,
                integrationCategory: integrationCategory,
                status: true,
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                authIntegration: { uuid: authIntegration?.uuid },
            });

            return { status: true };
        } catch (error) {
            this.logger.error({
                message: 'Error cloning integration',
                context: CloneIntegrationUseCase.name,
                error: error,
                metadata: {
                    ...params,
                    organizationId: this.request.user.organization.uuid,
                },
            });
            return { status: false };
        }
    }
}
