import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class SaveConfigUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },
    ) {}

    async execute(body: {
        domainSelected: string;
        projectSelected: string;
        teamSelected: string;
        boardSelected: string;
        teamId: string;
    }) {
        await this.projectManagementService.updateAuthIntegration({
            authDetails: {
                organization: body.domainSelected,
                projectSelected: body.projectSelected,
                teamSelected: body.teamSelected,
                boardSelected: body.boardSelected,
            },
            organizationAndTeamData: {
                organizationId: this.request.user?.organization?.uuid,
                teamId: body.teamId,
            },
        });
    }
}
