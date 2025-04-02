import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetPlatformsIntegrationsUseCase implements IUseCase {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) { }
    public async execute(teamId: string): Promise<{
        codeManagement: string;
        projectManagement: string;
        communication: string;
    }> {
        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId,
        };

        return await this.integrationService.getPlatformIntegration(
            organizationAndTeamData,
        );
    }
}
