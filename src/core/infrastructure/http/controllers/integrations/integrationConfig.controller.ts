import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { GetIntegrationConfigsByIntegrationCategoryUseCase } from '@/core/application/use-cases/integrations/integrationConfig/getIntegrationConfigsByIntegrationCategory.use-case';
import {
    CheckPolicies,
    PolicyGuard,
} from '@/core/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@/core/infrastructure/adapters/services/permissions/policy.handlers';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';

@Controller('integration-config')
export class IntegrationConfigController {
    constructor(
        private readonly getIntegrationConfigsByIntegrationCategoryUseCase: GetIntegrationConfigsByIntegrationCategoryUseCase,
    ) {}

    @Get('/get-integration-configs-by-integration-category')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Read,
        resource: ResourceType.GitSettings
    }))
    public async getIntegrationConfigsByIntegrationCategory(
        @Query('integrationCategory') integrationCategory: string,
        @Query('teamId') teamId: string,
    ) {
        return this.getIntegrationConfigsByIntegrationCategoryUseCase.execute({
            integrationCategory,
            teamId,
        });
    }
}
