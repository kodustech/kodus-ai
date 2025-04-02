import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Injectable } from '@nestjs/common';

@Injectable()
export class GetAuthUrlUseCase implements IUseCase {
    constructor(
        private readonly projectManagementService: ProjectManagementService,
    ) {}

    public async execute(platform: string): Promise<string> {
        return await this.projectManagementService.getAuthUrl(
            platform,
            platform.toUpperCase() as PlatformType,
        );
    }
}
