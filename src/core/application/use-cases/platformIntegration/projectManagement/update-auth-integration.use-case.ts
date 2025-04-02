import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class UpdateAuthIntegrationUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(params: any): Promise<any> {
        return await this.projectManagementService.updateAuthIntegration(
            {
                ...params,
                organizationId: this.request.user.organization.uuid,
            },
            params.integrationType,
        );
    }
}
