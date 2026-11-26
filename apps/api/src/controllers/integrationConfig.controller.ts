import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { ConnectionAccessService } from '@libs/identity/infrastructure/adapters/services/permissions/connection-access.service';
import {
    assertConnectionReadable,
    readableConnectionIds,
} from '@libs/identity/infrastructure/adapters/services/permissions/connection-read';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { GetIntegrationConfigsByIntegrationCategoryUseCase } from '@libs/integrations/application/use-cases/integrationConfig/getIntegrationConfigsByIntegrationCategory.use-case';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { ApiArrayResponseDto } from '../dtos/api-response.dto';

@ApiTags('Integration Config')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('integration-config')
export class IntegrationConfigController {
    constructor(
        private readonly getIntegrationConfigsByIntegrationCategoryUseCase: GetIntegrationConfigsByIntegrationCategoryUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly connectionAccess: ConnectionAccessService,
    ) {}

    @Get('/get-integration-configs-by-integration-category')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'List integration configs by category',
        description:
            'Return integration configurations for a category and team.',
    })
    @ApiQuery({ name: 'integrationCategory', type: String, required: true })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({
        name: 'connectionId',
        type: String,
        required: false,
        description:
            'A Git connection of the workspace; every connection when absent.',
    })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async getIntegrationConfigsByIntegrationCategory(
        @Query('integrationCategory') integrationCategory: string,
        @Query('teamId') teamId: string,
        @Query('connectionId') connectionId?: string,
    ) {
        const restriction = await this.connectionAccess.restrictionFor(
            this.request?.user,
        );
        assertConnectionReadable(restriction, connectionId);
        return this.getIntegrationConfigsByIntegrationCategoryUseCase.execute({
            integrationCategory,
            teamId,
            connectionId,
            readableConnectionIds: readableConnectionIds(restriction),
        });
    }
}
