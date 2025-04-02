import { IOrganizationAutomationService, ORGANIZATION_AUTOMATION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/organization-automation.service';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class GetOrganizationAutomationUseCase {
    constructor(
        @Inject(ORGANIZATION_AUTOMATION_SERVICE_TOKEN)
        private readonly organizationAutomationService: IOrganizationAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

    ) { }

    async execute(organizationId: string) {
        const organizationAutomation = await this.organizationAutomationService.find({
            organization: { uuid: organizationId },
        });

        return { hasOrganizationAutomation: !!organizationAutomation };
    }
}
