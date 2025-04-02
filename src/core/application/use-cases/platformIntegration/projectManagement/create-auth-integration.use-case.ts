import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Injectable } from '@nestjs/common';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

@Injectable()
export class CreateAuthIntegrationUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,
    ) {}

    public async execute(params: {
        tenantId: string;
        authToken: string;
        organizationId: string;
        integrationType: PlatformType;
    }): Promise<any> {
        return await this.projectManagementService.createAuthIntegration(
            params,
            params.integrationType,
        );
    }
}
