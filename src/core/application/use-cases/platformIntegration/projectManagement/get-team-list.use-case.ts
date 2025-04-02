import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetTeamListUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(domainSelected: string, projectSelected: string) {
        return this.projectManagementService.getTeams({
            domainSelected,
            projectSelected,
            organizationId: this.request.user.organization.uuid,
        });
    }
}
