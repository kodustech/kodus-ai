import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';

import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';

import { AutomationType } from '@/core/domain/automation/enums/automation-type';

import {
    IOrganizationAutomationService,
    ORGANIZATION_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/organization-automation.service';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@/shared/domain/contracts/message-broker.service.contracts';
import { PinoLoggerService } from '../../logger/pino.service';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationStatusFilter } from '@/core/domain/team/interfaces/team.interface';
import { STATUS } from '@/config/types/database/status.type';
import { TEAM_SERVICE_TOKEN } from '@/core/domain/team/contracts/team.service.contract';
import { ITeamService } from '@/core/domain/team/contracts/team.service.contract';

const API_CRON_AUTOMATION_EXECUTIVE_CHECKIN =
    process.env.API_CRON_AUTOMATION_EXECUTIVE_CHECKIN;

@Injectable()
export class WeeklyExecutiveCheckinCronProvider {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(ORGANIZATION_AUTOMATION_SERVICE_TOKEN)
        private readonly organizationAutomationService: IOrganizationAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_AUTOMATION_EXECUTIVE_CHECKIN, {
        name: AutomationType.AUTOMATION_EXECUTIVE_CHECKIN,
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            console.log('STARTING CRON - AUTOMATION - EXECUTIVE CHECK-IN');

            const automation = (
                await this.automationService.find({
                    automationType: AutomationType.AUTOMATION_EXECUTIVE_CHECKIN,
                })
            )?.[0];

            if (!automation) {
                return 'No automation found';
            }

            const organizationAutomations =
                await this.organizationAutomationService.find({
                    automation: { uuid: automation.uuid },
                    status: true,
                });

            if (!organizationAutomations) {
                return 'No team with active automation';
            }

            for (const organizationAutomation of organizationAutomations) {
                const teams = await this.teamService.findTeamsWithIntegrations({
                    organizationId: organizationAutomation.organization.uuid,
                    status: STATUS.ACTIVE,
                    integrationCategories: [IntegrationCategory.COMMUNICATION],
                    integrationStatus: IntegrationStatusFilter.CONFIGURED,
                });

                if (!teams || teams.length === 0) {
                    continue;
                }

                const automationData = {
                    organizationId: organizationAutomation.organization.uuid,
                    organizationAutomationId: organizationAutomation.uuid,
                };

                const automationDataPayload =
                    this.messageBroker.transformMessageToMessageBroker(
                        'cron.runWeeklyExecutiveCheckin',
                        automationData,
                    );

                await this.messageBroker.publishMessage(
                    {
                        exchange: 'orchestrator.exchange.delayed',
                        routingKey: 'cron.runWeeklyExecutiveCheckin',
                    },
                    automationDataPayload,
                );

                console.log(
                    'CRON - AUTOMATION - EXECUTIVE CHECK-IN - COMPLETED',
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing executive check-in',
                context: WeeklyExecutiveCheckinCronProvider.name,
                error: error,
            });
        }
    }
}
