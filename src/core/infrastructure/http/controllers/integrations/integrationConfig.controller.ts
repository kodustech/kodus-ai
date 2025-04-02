import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TeamQueryDto } from '../../dtos/teamId-query-dto';
import { CreateOrUpdateIntegrationConfigUseCase } from '@/core/application/use-cases/integrations/integrationConfig/createOrUpdateIntegrationConfig.use-case';
import { GetIntegrationConfigsByIntegrationCategoryUseCase } from '@/core/application/use-cases/integrations/integrationConfig/getIntegrationConfigsByIntegrationCategory.use-case';

@Controller('integration-config')
export class IntegrationConfigController {
    constructor(
        private readonly getIntegrationConfigsByIntegrationCategoryUseCase: GetIntegrationConfigsByIntegrationCategoryUseCase,
        private readonly createOrUpdateIntegrationConfigUseCase: CreateOrUpdateIntegrationConfigUseCase,
    ) {}

    @Post('/create-or-update-config')
    public async create(
        @Body()
        body: {},
    ) {
        return this.createOrUpdateIntegrationConfigUseCase.execute(body);
    }

    @Get('/get-integration-configs-by-integration-category')
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
