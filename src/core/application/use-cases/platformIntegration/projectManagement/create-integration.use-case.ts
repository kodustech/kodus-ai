import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class CreateIntegrationUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(params: {
        code: string;
        platformType: PlatformType;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        return await this.projectManagementService.createAuthIntegration(
            {
                code: params.code,
                organizationAndTeamData: {
                    organizationId:
                        params?.organizationAndTeamData?.organizationId ??
                        this.request.user?.organization?.uuid,
                    teamId: params?.organizationAndTeamData?.teamId,
                },
            },
            params.platformType,
        );
    }
}
