import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { TeamQueryDto } from '@/core/infrastructure/http/dtos/teamId-query-dto';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetBoardsListUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(
        domainSelected: string,
        projectSelected: string,
        teamSelected: string,
        teamId: string,
    ) {
        return this.projectManagementService.getBoard({
            domainSelected,
            projectSelected,
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId,
            },
        });
    }
}
