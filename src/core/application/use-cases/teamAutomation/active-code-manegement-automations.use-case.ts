import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { REQUEST } from '@nestjs/core';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { AutomationLevel } from '@/shared/domain/enums/automations-level.enum';
import { UpdateOrCreateTeamAutomationUseCase } from './updateOrCreateTeamAutomationUseCase';
import {
    AutomationCategoryMapping,
    AutomationType,
    AutomationTypeCategory,
} from '@/core/domain/automation/enums/automation-type';

@Injectable()
export class ActiveCodeManagementTeamAutomationsUseCase {
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
    ) { }

    async execute(teamId: string, notify: boolean = true) {
        const organizationAndTeamData = {
            organizationId: this.request.user?.organization?.uuid,
            teamId,
        };

        const codeManagementAutomations =
            AutomationCategoryMapping[AutomationTypeCategory.CODE_MANAGEMENT];

        const automations = await this.automationService.find({
            status: true,
            level: AutomationLevel.TEAM,
        });

        const automationsFiltered = automations.filter((automation) =>
            codeManagementAutomations.includes(automation.automationType),
        );

        const teamAutomations = {
            teamId: teamId,
            automations: automationsFiltered?.map((automation) =>
            ({
                automationUuid: automation.uuid,
                automationType: automation.automationType,
                status: automation.status,
            })
            ),
        };

        await this.updateOrCreateAutomationUseCase.execute(teamAutomations, notify);

        return teamAutomations.automations;
    }
}
