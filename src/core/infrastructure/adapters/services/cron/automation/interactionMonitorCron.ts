import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';

const API_CRON_AUTOMATION_INTERACTION_MONITOR =
    process.env.API_CRON_AUTOMATION_INTERACTION_MONITOR;

@Injectable()
export class InteractionMonitorCron {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,
    ) {}

    @Cron(API_CRON_AUTOMATION_INTERACTION_MONITOR, {
        name: AutomationType.AUTOMATION_INTERACTION_MONITOR,
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            console.log('STARTING CRON - AUTOMATION - InteractionMonitor');

            const automation = (
                await this.automationService.find({
                    automationType:
                        AutomationType.AUTOMATION_INTERACTION_MONITOR,
                })
            )[0];

            if (!automation) {
                throw new Error('No automation found');
            }

            const teamAutomation = await this.teamAutomationService.find({
                automation: { uuid: automation.uuid },
                status: true,
            });

            if (!teamAutomation) {
                throw new Error('No active team automation found');
            }

            teamAutomation.forEach((teamAutomation) => {
                this.executeAutomation.executeStrategy(
                    AutomationType.AUTOMATION_INTERACTION_MONITOR,
                    {
                        organizationAndTeamData: {
                            organizationId:
                                teamAutomation.team.organization.uuid,
                            teamId: teamAutomation.team.uuid,
                        },
                        teamAutomationId: teamAutomation.uuid,
                        origin: 'System',
                    },
                );
            });
        } catch (error) {
            console.log('Error executing weekly progress automation', error);
        }
    }
}
