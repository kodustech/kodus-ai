import { CreateTeamUseCase } from '@/core/application/use-cases/team/create.use-case';
import { FindFirstCreatedTeamUseCase } from '@/core/application/use-cases/team/find-first-created-team.use-case';
import { FinishSetupUseCase } from '@/core/application/use-cases/team/finish-setup.use-case';
import { GetByIdUseCase } from '@/core/application/use-cases/team/get-by-id.use-case';
import { ListTeamsUseCase } from '@/core/application/use-cases/team/list.use-case';
import { UpdateTeamUseCase } from '@/core/application/use-cases/team/update.use-case';
import { CreateTeamDto } from '@/core/infrastructure/http/dtos/create-team.dto';
import { UpdateTeamDto } from '@/core/infrastructure/http/dtos/update-team.dto';
import {
    Body,
    Controller,
    Delete,
    Patch,
    Get,
    Post,
    Query,
} from '@nestjs/common';
import { TeamQueryDto } from '../dtos/teamId-query-dto';
import { DeleteTeamUseCase } from '@/core/application/use-cases/team/delete.use-case';
import { ListTeamsWithIntegrationsUseCase } from '@/core/application/use-cases/team/list-with-integrations.use-case';

@Controller('team')
export class TeamController {
    constructor(
        private readonly createTeamUseCase: CreateTeamUseCase,
        private readonly updateTeamUseCase: UpdateTeamUseCase,
        private readonly listTeamsUseCase: ListTeamsUseCase,
        private readonly findFirstCreatedTeamUseCase: FindFirstCreatedTeamUseCase,
        private readonly getByIdUseCase: GetByIdUseCase,
        private readonly finishSetupUseCase: FinishSetupUseCase,
        private readonly deleteTeamUseCase: DeleteTeamUseCase,
        private readonly listTeamsWithIntegrationsUseCase: ListTeamsWithIntegrationsUseCase,
    ) {}

    @Post('/')
    public async create(@Body() body: CreateTeamDto) {
        return await this.createTeamUseCase.execute(body);
    }

    @Patch('/')
    public async update(@Body() body: UpdateTeamDto) {
        return await this.updateTeamUseCase.execute(body);
    }

    @Delete('/')
    public async delete(@Query() query: TeamQueryDto) {
        return await this.deleteTeamUseCase.execute(query?.teamId);
    }

    @Get('/')
    public async list() {
        return await this.listTeamsUseCase.execute();
    }

    @Get('/list-with-integrations')
    public async listWithIntegrations() {
        return await this.listTeamsWithIntegrationsUseCase.execute();
    }

    @Get('/get-by-id')
    public async getById(
        @Query()
        query: TeamQueryDto,
    ) {
        return await this.getByIdUseCase.execute(query?.teamId);
    }

    @Get('/first-created')
    public async findFirstCreatedTeam() {
        return await this.findFirstCreatedTeamUseCase.execute();
    }

    @Post('/finish-setup')
    public async startDiagnostic(@Body() body: TeamQueryDto) {
        return this.finishSetupUseCase.execute(body.teamId);
    }
}
