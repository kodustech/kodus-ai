import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PinoLoggerService } from '../logger/pino.service';
import {
    ISprintService,
    SPRINT_SERVICE_TOKEN,
} from '@/core/domain/sprint/contracts/sprint.service.contract';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { STATUS } from '@/config/types/database/status.type';
import { IntegrationStatusFilter } from '@/core/domain/team/interfaces/team.interface';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
const API_CRON_COMPILE_SPRINT = process.env.API_CRON_COMPILE_SPRINT;

@Injectable()
export class CompileSprintCronProvider {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(SPRINT_SERVICE_TOKEN)
        private readonly sprintService: ISprintService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_COMPILE_SPRINT, {
        name: 'Compile Sprint',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            const teams = await this.teamService.findTeamsWithIntegrations({
                status: STATUS.ACTIVE,
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                integrationCategories: [IntegrationCategory.PROJECT_MANAGEMENT],
            });

            for (const team of teams) {
                const teamMethod =
                    await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                        IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                        {
                            teamId: team.uuid,
                            organizationId: team.organization.uuid,
                        },
                    );

                if (teamMethod && teamMethod === 'scrum') {
                    await this.sprintService.compileLastSprint({
                        teamId: team.uuid,
                        organizationId: team.organization.uuid,
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error while executing sprint consolidation',
                context: CompileSprintCronProvider.name,
                error: error,
            });
        }
    }
}
