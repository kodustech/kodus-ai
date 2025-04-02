import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PinoLoggerService } from '../../logger/pino.service';
import * as moment from 'moment-timezone';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { ProjectManagementService } from '../../platformIntegration/projectManagement.service';
import { STATUS } from '@/config/types/database/status.type';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import {
    IntegrationMatchType,
    IntegrationStatusFilter,
} from '@/core/domain/team/interfaces/team.interface';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

const API_CRON_SPRINT_RETRO = process.env.API_CRON_SPRINT_RETRO;

@Injectable()
export class CronSprintRetroProvider {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        private readonly logger: PinoLoggerService,
        private readonly projectManagementService: ProjectManagementService,
    ) {}

    @Cron(API_CRON_SPRINT_RETRO, {
        name: 'Sprint Retro',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            this.logger.log({
                message: 'STARTING CRON - AUTOMATION - SPRINT RETRO',
                context: CronSprintRetroProvider.name,
            });

            console.log('STARTING CRON - AUTOMATION - SPRINT RETRO');

            const automation = (
                await this.automationService.find({
                    automationType: AutomationType.AUTOMATION_SPRINT_RETRO,
                })
            )[0];

            if (!automation) {
                throw new Error('No automation found');
            }

            const teamAutomations = await this.teamAutomationService.find({
                automation: { uuid: automation.uuid },
                status: true,
            });

            if (!teamAutomations) {
                this.logger.warn({
                    message: 'No team with active automation',
                    context: CronSprintRetroProvider.name,
                });

                return 'No team with active automation';
            }

            const filteredTeamAutomations =
                await this.teamService.filterTeamAutomationsByConfiguredIntegrations(
                    teamAutomations,
                    {
                        integrationCategories: [
                            IntegrationCategory.COMMUNICATION,
                            IntegrationCategory.PROJECT_MANAGEMENT,
                        ],
                        integrationStatus: IntegrationStatusFilter.CONFIGURED,
                        status: STATUS.ACTIVE,
                        matchType: IntegrationMatchType.EVERY,
                    },
                );

            if (!filteredTeamAutomations.length) {
                return 'No team with active automation and required integrations';
            }

            filteredTeamAutomations.forEach(async (teamAutomation) => {
                const organizationAndTeamData = {
                    organizationId: teamAutomation.team.organization.uuid,
                    teamId: teamAutomation.team.uuid,
                };

                const currentSprint =
                    await this.projectManagementService.getCurrentSprintForTeam(
                        {
                            organizationAndTeamData,
                        },
                    );

                if (!currentSprint || !currentSprint?.endDate) {
                    return;
                }

                if (
                    moment().format('YYYY-MM-DD') ===
                    moment(currentSprint.endDate).format('YYYY-MM-DD')
                ) {
                    this.executeAutomation.executeStrategy(
                        AutomationType.AUTOMATION_SPRINT_RETRO,
                        {
                            organizationAndTeamData,
                            teamAutomationId: teamAutomation.uuid,
                            origin: 'System',
                        },
                    );
                }
            });
        } catch (error) {
            this.logger.error({
                message: 'Error executing sprint consolidation',
                context: CronSprintRetroProvider.name,
                error: error,
            });
        }
    }
}
