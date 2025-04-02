import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CreateOrUpdateIntegrationConfigUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,
    ) {}

    public async execute(params: any): Promise<any> {
        return await this.projectManagementService.createOrUpdateIntegrationConfig(
            params,
            params.integrationType,
        );
    }
}
