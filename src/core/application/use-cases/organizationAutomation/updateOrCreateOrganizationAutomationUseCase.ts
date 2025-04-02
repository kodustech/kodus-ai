import { Inject, Injectable } from '@nestjs/common';

import { OrganizationAutomationsDto } from '@/core/infrastructure/http/dtos/team-automation.dto';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { IOrganizationAutomationService, ORGANIZATION_AUTOMATION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/organization-automation.service';

@Injectable()
export class UpdateOrCreateOrganizationAutomationUseCase {
    constructor(
        @Inject(ORGANIZATION_AUTOMATION_SERVICE_TOKEN)
        private readonly organizationAutomationService: IOrganizationAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

    ) { }

    async execute(organizationAutomations: OrganizationAutomationsDto) {
        const organizationData = {
            organizationId: this.request.user?.organization?.uuid,
        };

        const oldOrganizationAutomation = await this.organizationAutomationService.find({
            organization: { uuid: organizationAutomations.organizationId },
        });

        if (!oldOrganizationAutomation) {
            for (const organizationAutomation of organizationAutomations.automations) {
                if (organizationAutomation.status) {
                    this.executeAutomation.setupStrategy(
                        organizationAutomation?.automationType,
                        organizationData,
                    );
                }
            }
        } else {
            for (const organizationAutomation of organizationAutomations.automations) {
                const hasorganizationAutomation = oldOrganizationAutomation.find(
                    (old) =>
                        old.automation.uuid === organizationAutomation.automationUuid,
                );

                if (hasorganizationAutomation) {
                    this.organizationAutomationService.update(
                        { uuid: hasorganizationAutomation.uuid },
                        {
                            uuid: hasorganizationAutomation.uuid,
                            status: organizationAutomation.status,
                            organization: { uuid: organizationAutomations.organizationId },
                            automation: {
                                uuid: organizationAutomation.automationUuid,
                            },
                        },
                    );
                } else if (organizationAutomation.status) {
                    this.executeAutomation.setupStrategy(
                        AutomationType.AUTOMATION_TEAM_PROGRESS,
                        organizationData,
                    );
                }
            }
        }


    }
}
