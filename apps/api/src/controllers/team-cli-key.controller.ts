import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    UseGuards,
} from '@nestjs/common';

import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ITeamCliKeyConfig } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import { ManageTeamCliKeysUseCase } from '@libs/organization/application/use-cases/team-cli-key/manage.use-case';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    TeamCliKeyCreatedResponseDto,
    TeamCliKeyDeleteResponseDto,
    TeamCliKeyListResponseDto,
    TeamCliKeyUpdateResponseDto,
} from '../dtos/team-cli-key-response.dto';

/**
 * Controller for Team CLI Key management
 * Allows team managers to generate, list, and revoke CLI keys for their team
 */
@ApiTags('Team CLI Key')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('teams/:teamId/cli-keys')
@UseGuards(PolicyGuard)
export class TeamCliKeyController {
    constructor(
        private readonly manageTeamCliKeysUseCase: ManageTeamCliKeysUseCase,
    ) {}

    @Post()
    @CheckPolicies(
        checkRole({
            role: Role.OWNER,
        }),
    )
    @ApiOperation({
        summary: 'Create team CLI key',
        description: 'Generate a new CLI key for the specified team.',
    })
    @ApiCreatedResponse({ type: TeamCliKeyCreatedResponseDto })
    async generateKey(
        @Param('teamId') teamId: string,
        @Body() body: { name: string; config?: ITeamCliKeyConfig },
    ) {
        return this.manageTeamCliKeysUseCase.execute({
            action: 'generate',
            teamId,
            body,
        });
    }

    @Get()
    @CheckPolicies(
        checkRole({
            role: Role.OWNER,
        }),
    )
    @ApiOperation({
        summary: 'List team CLI keys',
        description: 'Return all CLI keys for the specified team.',
    })
    @ApiOkResponse({ type: TeamCliKeyListResponseDto })
    async listKeys(@Param('teamId') teamId: string) {
        return this.manageTeamCliKeysUseCase.execute({
            action: 'list',
            teamId,
        });
    }

    @Patch(':keyId/config')
    @CheckPolicies(
        checkRole({
            role: Role.OWNER,
        }),
    )
    @ApiOperation({
        summary: 'Update team CLI key config',
        description:
            'Update the config object for a CLI key belonging to the specified team.',
    })
    @ApiOkResponse({ type: TeamCliKeyUpdateResponseDto })
    async updateKeyConfig(
        @Param('teamId') teamId: string,
        @Param('keyId') keyId: string,
        @Body() body: { config?: ITeamCliKeyConfig },
    ) {
        return this.manageTeamCliKeysUseCase.execute({
            action: 'update',
            teamId,
            keyId,
            body,
        });
    }

    @Delete(':keyId')
    @CheckPolicies(
        checkRole({
            role: Role.OWNER,
        }),
    )
    @ApiOperation({
        summary: 'Revoke team CLI key',
        description: 'Revoke a CLI key by id for the specified team.',
    })
    @ApiOkResponse({ type: TeamCliKeyDeleteResponseDto })
    async revokeKey(
        @Param('teamId') teamId: string,
        @Param('keyId') keyId: string,
    ) {
        return this.manageTeamCliKeysUseCase.execute({
            action: 'revoke',
            teamId,
            keyId,
        });
    }
}
