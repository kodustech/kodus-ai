import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import * as moment from 'moment';

@Injectable()
export class EnsureTaskDescriptionCron {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    @Cron(process.env.API_CRON_AUTOMATION_ISSUES_DETAILS)
    async handleCron() {
        try {
            console.log(
                'STARTING CRON - AUTOMATION - EnsureTaskDescriptionQuality',
            );

            const automation = await this.automationService.findOne({
                automationType: AutomationType.AUTOMATION_ISSUES_DETAILS,
            });

            if (!automation) {
                throw new Error('No automation found');
            }

            const teamsAutomation = await this.teamAutomationService.find({
                automation: { uuid: automation.uuid },
                status: true,
            });

            if (!teamsAutomation) {
                return 'No team with active automation';
            }

            for (const teamAutomation of teamsAutomation) {
                // Define the alert time
                const issueAlertTimeConfig =
                    await this.integrationConfigService.findIntegrationConfigFormatted<{
                        utc: string;
                    }>(IntegrationConfigKey.AUTOMATION_ISSUE_ALERT_TIME, {
                        teamId: teamAutomation?.team?.uuid,
                        organizationId:
                            teamAutomation?.team?.organization?.uuid,
                    });

                if (!issueAlertTimeConfig?.utc) {
                    continue;
                }

                const currentTimeStamp = moment()
                    .utc()
                    .startOf('minute')
                    .valueOf();

                const notifyDate = moment(
                    issueAlertTimeConfig?.utc,
                    'HH:mm',
                ).valueOf();

                if (currentTimeStamp === notifyDate) {
                    this.executeAutomation.executeStrategy(
                        AutomationType.AUTOMATION_ISSUES_DETAILS,
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
                }
            }
        } catch (error) {
            console.log(error);
        }
    }
}
