import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Injectable } from '@nestjs/common';

@Injectable()
export class GetOrganizationUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) {}

    public async execute() {
        return this.codeManagementService.getOrganizations({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
            },
        });
    }
}
