import { createLogger } from '@libs/core/log/logger';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    toIntegrationCategory,
    toPlatformType,
} from '@libs/common/utils/enum-utils';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';

export class CloneIntegrationUseCase implements IUseCase {
    private readonly logger = createLogger(CloneIntegrationUseCase.name);
    constructor(
        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
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
