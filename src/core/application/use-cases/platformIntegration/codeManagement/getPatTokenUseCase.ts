import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigService } from '@/core/infrastructure/adapters/services/integrations/integrationConfig.service';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class GetPatTokenUseCase implements IUseCase {
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IntegrationConfigService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },
    ) {}

    async execute(params: { teamId: string }) {
        return await this.integrationConfigService.findOne({
            configKey: IntegrationConfigKey.CODE_MANAGEMENT_PAT,
            team: {
                uuid: params.teamId,
            },
        });
    }
}
