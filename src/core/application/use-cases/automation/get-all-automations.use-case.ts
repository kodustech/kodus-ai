import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    TEAM_AUTOMATION_SERVICE_TOKEN,
    ITeamAutomationService,
} from '@/core/domain/automation/contracts/team-automation.service';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';

@Injectable()
export class GetAllAutomationsUseCase {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) { }

    async execute(teamId: string) {
        const automations = await this.automationService.find();

        const teamAutomation = await this.teamAutomationService.find({
            team: { uuid: teamId },
        });

        return automations?.map((automation) => {
            const hasTeamAutomation = teamAutomation?.find(
                (old) => old.automation?.uuid === automation?.uuid,
            );

            const automationReturned = {
                id: automation.uuid,
                name: automation.name,
                description: automation.description,
                tags: automation.tags,
                antiPatterns: automation.antiPatterns,
                active: hasTeamAutomation?.status ?? false,
                isDefaultDisabled: false,
                comingSoon: !automation.status,
                automationType: automation.automationType,
                level: automation.level,
            };

            if (
                automation.automationType ===
                AutomationType.AUTOMATION_IMPROVE_TASK
            ) {
                automationReturned.active = true;
                automationReturned.isDefaultDisabled = true;
            }

            return automationReturned;
        });
    }
}
