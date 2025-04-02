import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { TeamQueryDto } from '@/core/infrastructure/http/dtos/teamId-query-dto';

import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class GetColumnsBoardUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,

        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) {}

    async execute(teamId: string) {
        return await this.projectManagementService.getColumnsFormatted({
            organizationAndTeamData: {
                organizationId: this.request.user?.organization?.uuid,
                teamId,
            },
        });
    }
}
