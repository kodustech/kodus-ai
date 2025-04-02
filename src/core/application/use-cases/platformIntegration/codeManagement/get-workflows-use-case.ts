import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class GetWorkflowsUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) { }

    public async execute(params: {
        teamId: string;
    }) {
        return this.codeManagementService.getWorkflows({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId: params.teamId,
            },
        });
    }
}
