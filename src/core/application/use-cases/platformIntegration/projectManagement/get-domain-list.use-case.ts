import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class GetDomainsListUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(teamId: string) {
        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId,
        };

        return this.projectManagementService.getDomain({
            organizationAndTeamData,
        });
    }
}
