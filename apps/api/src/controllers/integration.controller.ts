import {
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { CheckHasIntegrationByPlatformUseCase } from '@libs/integrations/application/use-cases/check-has-connection.use-case';
import { CloneIntegrationUseCase } from '@libs/integrations/application/use-cases/clone-integration.use-case';
import { GetConnectionsUseCase } from '@libs/platform/application/use-cases/integrations/get-connections.use-case';
import { GetOrganizationIdUseCase } from '@libs/integrations/application/use-cases/get-organization-id.use-case';
import { TeamQueryDto } from '@libs/organization/dtos/teamId-query.dto';
import {
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    ApiArrayResponseDto,
    ApiBooleanResponseDto,
    ApiStringResponseDto,
} from '../dtos/api-response.dto';
import { IntegrationCloneResponseDto } from '../dtos/integration-response.dto';

@ApiTags('Integration')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('integration')
export class IntegrationController {
    constructor(
        private readonly getOrganizationIdUseCase: GetOrganizationIdUseCase,
        private readonly cloneIntegrationUseCase: CloneIntegrationUseCase,
        private readonly checkHasIntegrationByPlatformUseCase: CheckHasIntegrationByPlatformUseCase,
        private readonly getConnectionsUseCase: GetConnectionsUseCase,
        private readonly codeManagementService: CodeManagementService,
        // HTTP-only controller — REQUEST carries the org from the JWT; the team
        // comes from the query (the web passes the selected team).
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/clone-integration')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Clone integration',
        description: 'Clone integration settings from another team.',
    })
    @ApiCreatedResponse({ type: IntegrationCloneResponseDto })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                teamId: { type: 'string' },
                teamIdClone: { type: 'string' },
                integrationData: {
                    type: 'object',
                    properties: {
                        platform: { type: 'string' },
                        category: { type: 'string' },
                    },
                    required: ['platform', 'category'],
                },
            },
            required: ['teamId', 'teamIdClone', 'integrationData'],
            example: {
                teamId: 'c33ef663-70e7-4f43-9605-0bbef979b8e0',
                teamIdClone: '0b0a8c2a-9c03-4b13-8ee0-2e6c4c04f1d1',
                integrationData: {
                    platform: 'github',
                    category: 'code',
                },
            },
        },
    })
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
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Check connection by platform',
        description: 'Return whether the integration is connected.',
    })
    @ApiOkResponse({ type: ApiBooleanResponseDto })
    public async checkHasConnectionByPlatform(@Query() query: any) {
        return this.checkHasIntegrationByPlatformUseCase.execute(query);
    }

    @Get('/issues-supported')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Check whether the code host supports reading issues',
        description:
            "Whether the team's connected code host has a native issue tracker (false for Azure Repos and Bitbucket Data Center). Used to gate installing the generic issues MCP.",
    })
    @ApiOkResponse({ type: ApiBooleanResponseDto })
    public async isIssuesSupported(@Query('teamId') teamId: string) {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId || !teamId) {
            return false;
        }

        return this.codeManagementService.isIssuesSupported({
            organizationId,
            teamId,
        });
    }

    @Get('/organization-id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get organization id',
        description:
            'Return the organization id for the current integration context.',
    })
    @ApiOkResponse({ type: ApiStringResponseDto })
    public async getOrganizationId() {
        return this.getOrganizationIdUseCase.execute();
    }

    @Get('/connections')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'List connections',
        description: 'Return connections for a team.',
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async getConnections(@Query() query: TeamQueryDto) {
        return this.getConnectionsUseCase.execute(query.teamId);
    }
}
