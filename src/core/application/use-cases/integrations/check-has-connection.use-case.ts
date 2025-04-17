import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import {
    toIntegrationCategory,
    toPlatformType,
} from '@/shared/utils/enum-utils';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class CheckHasIntegrationByPlatformUseCase implements IUseCase {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}
    public async execute(params: any): Promise<any> {
        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
        };

        const platformType = toPlatformType(params.platform);
        const integrationCategory = toIntegrationCategory(params.category);

        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            status: true,
            platform: platformType,
            integrationCategory: integrationCategory,
        });

        return !!integration;
    }
}
