import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationConfigKeyProjectManagement } from '@/shared/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetIntegrationConfigsByIntegrationCategoryUseCase
    implements IUseCase
{
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

            const integrationConfigs = await this.integrationConfigService.find(
                {
                    integration: { uuid: integration.uuid },
                    team: { uuid: organizationAndTeamData.teamId },
                },
            );

            if (
                params.integrationCategory ===
                IntegrationCategory.CODE_MANAGEMENT
            ) {
                return this.formatResultCodeManagement(integrationConfigs);
            }

            return this.formatResult(integrationConfigs);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching integration configuration data',
                context: GetIntegrationConfigsByIntegrationCategoryUseCase.name,
                error: error,
                metadata: {
                    automationName: params.automationName,
                },
            });
        }
    }

    private formatResult(integrationConfigs: IntegrationConfigEntity[]) {
        if (!integrationConfigs || integrationConfigs.length === 0) {
            return [];
        }

        const result = Object.values(IntegrationConfigKeyProjectManagement).map(
            (key) => {
                const config = integrationConfigs.find(
                    (config) => config.configKey === (key as unknown as string),
                );
                return {
                    configKey: key,
                    configValue: config ? config.configValue : '',
                };
            },
        );

        return result;
    }

    private formatResultCodeManagement(
        integrationConfigs: IntegrationConfigEntity[],
    ) {
        if (!integrationConfigs || integrationConfigs.length === 0) {
            return [];
        }

        const result = integrationConfigs.map((config) => {
            return {
                configKey: config.configKey,
                configValue: config.configValue,
            };
        });

        return result;
    }
}
