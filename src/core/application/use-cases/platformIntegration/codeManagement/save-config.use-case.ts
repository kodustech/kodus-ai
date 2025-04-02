import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class SaveCodeConfigUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },
    ) {}

    async execute(body: {
        organizationSelected: string;
        teamId: string;
    }) {
        await this.codeManagementService.updateAuthIntegration({
            authDetails: {
                organization: body.organizationSelected,
            },
            organizationAndTeamData: {
                organizationId: this.request.user?.organization?.uuid,
                teamId: body.teamId,
            },
        });
    }
}
