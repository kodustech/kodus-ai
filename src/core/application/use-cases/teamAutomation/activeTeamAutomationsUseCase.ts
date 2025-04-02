import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { REQUEST } from '@nestjs/core';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { AutomationLevel } from '@/shared/domain/enums/automations-level.enum';
import { UpdateOrCreateTeamAutomationUseCase } from './updateOrCreateTeamAutomationUseCase';

@Injectable()
export class ActiveTeamAutomationsUseCase {
    constructor(
        private readonly updateOrCreateAutomationUseCase: UpdateOrCreateTeamAutomationUseCase,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(teamId: string) {
        const organizationAndTeamData = {
            organizationId: this.request.user?.organization?.uuid,
            teamId,
        };

        const automations = await this.automationService.find({
            status: true,
            level: AutomationLevel.TEAM,
        });

        const teamAutomations = {
            teamId: teamId,
            automations: automations?.map((automation) => ({
                automationUuid: automation.uuid,
                automationType: automation.automationType,
                status: automation.status,
            })),
        };

        await this.updateOrCreateAutomationUseCase.execute(teamAutomations);

        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            integrationCategory: IntegrationCategory.COMMUNICATION,
            status: true,
        });

        //By default, the Daily notification will be sent at 9 AM
        await this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.DAILY_CHECKIN_SCHEDULE,
            { utc: '12:00' },
            integration?.uuid,
            {
                organizationId: this.request.user?.organization?.uuid,
                teamId: teamId,
            },
        );

        //By default, the Daily notification will be sent at 8 AM
        await this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.AUTOMATION_ISSUE_ALERT_TIME,
            { utc: '11:00' },
            integration?.uuid,
            {
                organizationId: this.request.user?.organization?.uuid,
                teamId: teamId,
            },
        );
    }
}
