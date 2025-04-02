import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { REQUEST } from '@nestjs/core';
import { AutomationLevel } from '@/shared/domain/enums/automations-level.enum';
import { UpdateOrCreateTeamAutomationUseCase } from './updateOrCreateTeamAutomationUseCase';
import {
    AutomationCategoryMapping,
    AutomationTypeCategory,
} from '@/core/domain/automation/enums/automation-type';

@Injectable()
export class ActiveProjectManagementTeamAutomationsUseCase {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        private readonly updateOrCreateAutomationUseCase: UpdateOrCreateTeamAutomationUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(teamId: string, notify: boolean = true) {
        const projectManagementAutomations =
            AutomationCategoryMapping[
                AutomationTypeCategory.PROJECT_MANAGEMENT
            ];

        const automations = await this.automationService.find({
            status: true,
            level: AutomationLevel.TEAM,
        });

        const automationsFiltered = automations.filter((automation) =>
            projectManagementAutomations.includes(automation.automationType),
        );

        const teamAutomations = {
            teamId: teamId,
            automations: automationsFiltered?.map((automation) => ({
                automationUuid: automation.uuid,
                automationType: automation.automationType,
                status: automation.status,
            })),
        };

        await this.updateOrCreateAutomationUseCase.execute(
            teamAutomations,
            notify,
        );
    }
}
