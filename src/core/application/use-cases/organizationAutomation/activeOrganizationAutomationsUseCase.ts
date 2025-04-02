import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';

import { AutomationLevel } from '@/shared/domain/enums/automations-level.enum';
import { UpdateOrCreateOrganizationAutomationUseCase } from './updateOrCreateOrganizationAutomationUseCase';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class ActiveOrganizationAutomationsUseCase {
    constructor(
        private readonly updateOrCreateOrganizationAutomationUseCase: UpdateOrCreateOrganizationAutomationUseCase,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute() {
        const organizationId = this.request.user.organization.uuid;

        const automations = await this.automationService.find({
            status: true,
            level: AutomationLevel.ORGANIZATION,
        });

        const organizationAutomations = {
            organizationId: organizationId,
            automations: automations?.map((automation) => ({
                automationUuid: automation.uuid,
                automationType: automation.automationType,
                status: automation.status,
            })),
        };

        await this.updateOrCreateOrganizationAutomationUseCase.execute(
            organizationAutomations,
        );
    }
}
