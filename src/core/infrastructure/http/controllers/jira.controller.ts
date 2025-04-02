import { GetUsersInBoardByNameUseCase } from '@/core/application/use-cases/jira/get-users-in-board-by-name';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CreateOrUpdateColumnsBoardUseCase } from '@/core/application/use-cases/jira/create-or-update-jira-columns.use-case';
import { ColumnsConfigKey } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { TeamQueryDto } from '../dtos/teamId-query-dto';

export type IntegrationsCommon = {
    name: string;
    id: string;
    key?: string;
};

@Controller('jira')
export class JiraController {
    constructor(
        private readonly getUsersInBoardByNameUseCase: GetUsersInBoardByNameUseCase,
        private readonly createOrUpdateColumnsBoardUseCase: CreateOrUpdateColumnsBoardUseCase,
    ) {}

    @Post('/columns')
    public async createOrUpdateColumns(
        @Body()
        body: {
            columns: ColumnsConfigKey[];
            teamId: TeamQueryDto;
        },
    ) {
        return this.createOrUpdateColumnsBoardUseCase.execute(body);
    }

    // Lists the active users on the board.
    @Get('/board-users')
    public async getProjectUsers() {
        return this.getUsersInBoardByNameUseCase.execute();
    }
}
