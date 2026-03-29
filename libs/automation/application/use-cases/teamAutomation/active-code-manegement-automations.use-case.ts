import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@libs/automation/domain/automation/contracts/automation.service';
import {
    AutomationCategoryMapping,
    AutomationTypeCategory,
} from '@libs/automation/domain/automation/enum/automation-type';
import { AutomationLevel } from '@libs/core/domain/enums/automations-level.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';

import { UpdateOrCreateTeamAutomationUseCase } from './updateOrCreateTeamAutomationUseCase';

@Injectable()
export class ActiveCodeManagementTeamAutomationsUseCase implements IUseCase {
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
        const codeManagementAutomations =
            AutomationCategoryMapping[AutomationTypeCategory.CODE_MANAGEMENT];

        const automations =
            (await this.automationService.find({
                status: true,
                level: AutomationLevel.TEAM,
            })) || [];

        const automationsFiltered = automations.filter((automation) =>
            codeManagementAutomations.includes(automation.automationType),
        );

        const teamAutomations = {
            teamId: teamId,
            automations: automationsFiltered?.map((automation) => ({
                automationUuid: automation.uuid,
                automationType: automation.automationType,
                status: automation.status,
            })),
        };

        await this.updateOrCreateAutomationUseCase.execute(teamAutomations);

        return teamAutomations.automations;
    }
}
