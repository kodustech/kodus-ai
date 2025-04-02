import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetRepositoriesUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) {}

    public async execute(params: {
        teamId: string;
        organizationSelected: any;
    }) {
        return this.codeManagementService.getRepositories({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId: params?.teamId,
            },
            organizationSelected: params?.organizationSelected,
        });
    }
}
