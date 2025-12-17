import { CheckHasIntegrationByPlatformUseCase } from '@/core/application/use-cases/integrations/check-has-connection.use-case';
import { CloneIntegrationUseCase } from '@/core/application/use-cases/integrations/clone-integration.use-case';
import { GetConnectionsUseCase } from '@/core/application/use-cases/integrations/get-connections.use-case';
import { GetOrganizationIdUseCase } from '@/core/application/use-cases/integrations/get-organization-id.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@/core/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@/core/infrastructure/adapters/services/permissions/policy.handlers';
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { TeamQueryDto } from '../../dtos/teamId-query-dto';

@Controller('integration')
export class IntegrationController {
    constructor(
        private readonly getOrganizationIdUseCase: GetOrganizationIdUseCase,
        private readonly cloneIntegrationUseCase: CloneIntegrationUseCase,
        private readonly checkHasIntegrationByPlatformUseCase: CheckHasIntegrationByPlatformUseCase,
        private readonly getConnectionsUseCase: GetConnectionsUseCase,
    ) {}

    @Post('/clone-integration')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Create,
        resource: ResourceType.GitSettings
    }))
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
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Read,
        resource: ResourceType.GitSettings
    }))
    public async checkHasConnectionByPlatform(@Query() query: any) {
        return this.checkHasIntegrationByPlatformUseCase.execute(query);
    }

    @Get('/organization-id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Read,
        resource: ResourceType.GitSettings
    }))
    public async getOrganizationId() {
        return this.getOrganizationIdUseCase.execute();
    }

    @Get('/connections')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings
        }),
    )
    public async getConnections(@Query() query: TeamQueryDto) {
        return this.getConnectionsUseCase.execute(query.teamId);
    }
}
