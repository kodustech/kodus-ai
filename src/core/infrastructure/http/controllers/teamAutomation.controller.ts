import {
    BadRequestException,
    Body,
    Controller,
    Get,
    InternalServerErrorException,
    Post,
    Query,
} from '@nestjs/common';
import { GetTeamAutomationUseCase } from '@/core/application/use-cases/teamAutomation/getTeamAutomationUseCase';
import { TeamQueryDto } from '../dtos/teamId-query-dto';
import { TeamAutomationsDto } from '../dtos/team-automation.dto';
import { ListAllTeamAutomationUseCase } from '@/core/application/use-cases/teamAutomation/listAllTeamAutomationUseCase';
import { UpdateTeamAutomationStatusUseCase } from '@/core/application/use-cases/teamAutomation/updateTeamAutomationStatusUseCase';
import { ActiveTeamAutomationsUseCase } from '@/core/application/use-cases/teamAutomation/activeTeamAutomationsUseCase';
import { UpdateOrCreateTeamAutomationUseCase } from '@/core/application/use-cases/teamAutomation/updateOrCreateTeamAutomationUseCase';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { OrganizationAndTeamDataDto } from '../dtos/organizationAndTeamData.dto';
import { RunTeamAutomationsUseCase } from '@/core/application/use-cases/teamAutomation/run-team-automations';
import { PinoLoggerService } from '../../adapters/services/logger/pino.service';

@Controller('team-automation')
export class TeamAutomationController {
    constructor(
        private readonly updateOrCreateAutomationUseCase: UpdateOrCreateTeamAutomationUseCase,
        private readonly getTeamAutomationUseCase: GetTeamAutomationUseCase,
        private readonly listAllTeamAutomationUseCase: ListAllTeamAutomationUseCase,
        private readonly updateTeamAutomationStatusUseCase: UpdateTeamAutomationStatusUseCase,
        private readonly activeTeamAutomationsUseCase: ActiveTeamAutomationsUseCase,
        private readonly runTeamAutomationsUseCase: RunTeamAutomationsUseCase,

        private readonly logger: PinoLoggerService,
    ) {}

    @Post('/')
    public async updateOrCreateAutomation(@Body() body: TeamAutomationsDto) {
        return this.updateOrCreateAutomationUseCase.execute(body);
    }

    @Post('/active-all')
    public async activeAllAutomations(@Body() body: TeamQueryDto) {
        return this.activeTeamAutomationsUseCase.execute(body.teamId);
    }

    @Get('/')
    public async GetTeamAutomationUseCase(@Query() query: TeamQueryDto) {
        return this.getTeamAutomationUseCase.execute(query.teamId);
    }

    @Get('/list-all')
    public async ListAllTeamAutomationUseCase(@Query() query: TeamQueryDto) {
        return this.listAllTeamAutomationUseCase.execute(query.teamId);
    }

    @Post('/update-status')
    public async changeStatus(
        @Body() body: { teamAutomationId: string; status: boolean },
    ) {
        return await this.updateTeamAutomationStatusUseCase.execute(
            body.teamAutomationId,
            body.status,
        );
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
        if (!body.automationName || !body.organizationAndTeamData) {
            throw new BadRequestException('Invalid automation data');
        }

        const originModded = body.origin ?? 'System';

        try {
            return await this.runTeamAutomationsUseCase.execute({
                ...body,
                origin: originModded,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error while executing automation',
                context: TeamAutomationController.name,
                error: error,
            });

            throw new InternalServerErrorException(
                'Failed to execute automation',
            );
        }
    }
}
