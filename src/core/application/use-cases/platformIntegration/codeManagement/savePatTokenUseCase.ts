import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class SavePatTokenConfigUseCase implements IUseCase {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },
    ) {}

    async execute(params: { token: string; teamId: string }) {
        const organizationAndTeamData = {
            teamId: params.teamId,
            organizationId: this.request.user?.organization?.uuid,
        };

        try {
            await this.codeManagementService.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.CODE_MANAGEMENT_PAT,
                configValue: params.token,
                organizationAndTeamData,
            });

            return 'success';
        } catch (error) {
            this.logger.error({
                message: 'Error saving the configuration key for code review',
                context: SavePatTokenConfigUseCase.name,
                error: error,
                metadata: {
                    organizationAndTeamData,
                },
            });
        }
    }
}
