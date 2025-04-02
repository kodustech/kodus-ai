import { GetConnectionsUseCase } from '@/core/application/use-cases/integrations/get-connections.use-case';
import { GetOrganizationIdUseCase } from '@/core/application/use-cases/integrations/get-organization-id.use-case';
import { GetPlatformsIntegrationsUseCase } from '@/core/application/use-cases/integrations/get-platforms-integrations.use-case';
import { GetWorkspaceIdUseCase } from '@/core/application/use-cases/integrations/get-workspace-id.use-case';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TeamQueryDto } from '../../dtos/teamId-query-dto';
import { PlatformTypeDto } from '../../dtos/platform-type.dto';
import { CloneIntegrationUseCase } from '@/core/application/use-cases/integrations/clone-integration.use-case';
import { CheckHasIntegrationByPlatformUseCase } from '@/core/application/use-cases/integrations/check-has-connection.use-case';

@Controller('integration')
export class IntegrationController {
    constructor(
        private readonly getConnectionsUseCase: GetConnectionsUseCase,
        private readonly getWorkspaceIdUseCase: GetWorkspaceIdUseCase,
        private readonly getPlatformsIntegrationsUseCase: GetPlatformsIntegrationsUseCase,
        private readonly getOrganizationIdUseCase: GetOrganizationIdUseCase,
        private readonly cloneIntegrationUseCase: CloneIntegrationUseCase,
        private readonly checkHasIntegrationByPlatformUseCase: CheckHasIntegrationByPlatformUseCase,
    ) {}

    @Post('/clone-integration')
    public async cloneIntegration(
        @Body()
        body: {
            teamId: string;
            teamIdClone: string;
            integrationData: { platform: string; category: string };
        },
    ) {
        return this.cloneIntegrationUseCase.execute(body);
    }

    @Get('/check-connection-platform')
    public async checkHasConnectionByPlatform(@Query() query: any) {
        return this.checkHasIntegrationByPlatformUseCase.execute(query);
    }

    @Get('/connections')
    public async getConnections(@Query() query: TeamQueryDto) {
        return this.getConnectionsUseCase.execute(query.teamId);
    }

    @Get('/organization-id')
    public async getOrganizationId() {
        return this.getOrganizationIdUseCase.execute();
    }

    @Get('/worskpace-id')
    public async getWorkspaceId(
        @Query() query: PlatformTypeDto,
        @Query() team: TeamQueryDto,
    ) {
        return this.getWorkspaceIdUseCase.execute(
            query?.platformType,
            team.teamId,
        );
    }

    @Get('/platforms')
    public async getPlatformsIntegrations(@Query() team: TeamQueryDto) {
        return this.getPlatformsIntegrationsUseCase.execute(team.teamId);
    }
}
