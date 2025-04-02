import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class CreateOrUpdateIntegrationConfigUseCase implements IUseCase {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
    ) {}
    public async execute(params: any): Promise<any> {
        try {
            const organizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
                teamId: params.teamId,
            };

            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                integrationCategory: params.integrationCategory,
                status: true,
            });

            if (!integration) {
                return [];
            }

            await Promise.all(
                params.integrationConfigs.map(async (integrationConfig) => {
                    return this.integrationConfigService.createOrUpdateConfig(
                        integrationConfig.configKey,
                        integrationConfig.configValue,
                        integration.uuid,
                        organizationAndTeamData,
                    );
                }),
            );

            return { success: true };
        } catch (error) {
            this.logger.error({
                message: 'Error creating or updating integration configuration',
                context: CreateOrUpdateIntegrationConfigUseCase.name,
                error: error,
                metadata: {
                    automationName: params.automationName,
                },
            });
            throw new Error('Failed to process integration configuration');
        }
    }
}
