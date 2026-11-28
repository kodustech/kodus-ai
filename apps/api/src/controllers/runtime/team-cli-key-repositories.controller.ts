import { Body, Controller, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { SetTeamCliKeyRepositoriesUseCase } from '../../use-cases/set-team-cli-key-repositories.use-case';
import { SetTeamCliKeyRepositoriesDto } from './runtime.dto';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/** The repos a team CLI key reaches (ADR-057), in the URL family of the CLI key routes. A Runtime field: released with the Runtime. */
@ApiTags('Team CLI Key')
@ApiStandardResponses()
@ApiBearerAuth('jwt')
@Controller('teams/:teamId/cli-keys')
@UseGuards(RuntimeReleaseGuard, PolicyGuard)
export class TeamCliKeyRepositoriesController {
    constructor(private readonly setRepositoriesUseCase: SetTeamCliKeyRepositoriesUseCase) {}

    @Put(':keyId/repositories')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Set the repositories of a team CLI key', description: 'Replaces the list; every repo must be configured for the key team.' })
    setRepositories(@Req() req: UserRequest, @Param('teamId') teamId: string, @Param('keyId') keyId: string, @Body() body: SetTeamCliKeyRepositoriesDto) {
        return this.setRepositoriesUseCase.execute({ user: req.user, teamId, keyId, repositoryIds: body.repositoryIds });
    }
}
