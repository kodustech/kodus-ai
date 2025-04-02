import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TeamQueryDto } from '../dtos/teamId-query-dto';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { OrganizationAndTeamDataDto } from '../dtos/organizationAndTeamData.dto';
import { GetAllAutomationsUseCase } from '@/core/application/use-cases/automation/get-all-automations.use-case';
import { RunAutomationUseCase } from '@/core/application/use-cases/automation/run-automation.use-case';

@Controller('automation')
export class AutomationController {
    constructor(
        private readonly getAllAutomationsUseCase: GetAllAutomationsUseCase,
        private readonly runAutomationUseCase: RunAutomationUseCase,
    ) { }

    @Get('/')
    public async getAllAutomations(@Query() query: TeamQueryDto) {
        return this.getAllAutomationsUseCase.execute(query.teamId);
    }

    @Post('/run')
    public async runAutomation(
        @Body()
        body: {
            automationName: AutomationType;
            organizationAndTeamData: OrganizationAndTeamDataDto;
            channelId?: string;
            origin?: string;
        },
    ) {
        let originModded = 'System';

        if (body.origin) {
            originModded = body.origin;
        }

        return await this.runAutomationUseCase.execute({
            ...body,
            origin: originModded,
        });
    }
}
