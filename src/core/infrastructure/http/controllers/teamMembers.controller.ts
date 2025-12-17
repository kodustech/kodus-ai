import { CreateOrUpdateTeamMembersUseCase } from '@/core/application/use-cases/teamMembers/create.use-case';
import { DeleteTeamMembersUseCase } from '@/core/application/use-cases/teamMembers/delete.use-case';
import { GetTeamMembersUseCase } from '@/core/application/use-cases/teamMembers/get-team-members.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { IMembers } from '@/core/domain/teamMembers/interfaces/team-members.interface';
import {
    Body,
    Controller,
    DefaultValuePipe,
    Delete,
    Get,
    Param,
    ParseBoolPipe,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import {
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import { checkPermissions } from '../../adapters/services/permissions/policy.handlers';
import { TeamQueryDto } from '../dtos/teamId-query-dto';

@Controller('team-members')
export class TeamMembersController {
    constructor(
        private readonly createOrUpdateTeamMembersUseCase: CreateOrUpdateTeamMembersUseCase,
        private readonly getTeamMembersUseCase: GetTeamMembersUseCase,
        private readonly deleteTeamMembersUseCase: DeleteTeamMembersUseCase,
    ) {}

    @Get('/')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Read,
        resource: ResourceType.UserSettings
    }))
    public async getTeamMembers(@Query() query: TeamQueryDto) {
        return this.getTeamMembersUseCase.execute(query.teamId);
    }

    @Post('/')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Create,
        resource: ResourceType.UserSettings
    }))
    public async createOrUpdateTeamMembers(
        @Body() body: { members: IMembers[]; teamId: string },
    ) {
        return this.createOrUpdateTeamMembersUseCase.execute(
            body.teamId,
            body.members,
        );
    }

    @Delete('/:uuid')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Delete,
        resource: ResourceType.UserSettings
    }))
    public async deleteTeamMember(
        @Param('uuid') uuid: string,
        @Query('removeAll', new DefaultValuePipe(false), ParseBoolPipe)
        removeAll: boolean,
    ) {
        return this.deleteTeamMembersUseCase.execute(uuid, removeAll);
    }
}
