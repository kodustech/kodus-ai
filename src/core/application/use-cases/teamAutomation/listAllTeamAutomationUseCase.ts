import { Inject, Injectable } from '@nestjs/common';
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
export class ListAllTeamAutomationUseCase {
    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}

    async execute(teamId: string) {
        const teamAutomation = await this.teamAutomationService.find({
            team: { uuid: teamId },
        });

        return teamAutomation
            ?.filter((teamAutomation) => {
                return (
                    teamAutomation.automation.automationType !==
                    AutomationType.AUTOMATION_IMPROVE_TASK
                );
            })
            .map((teamAutomation) => {
                return {
                    uuid: teamAutomation.uuid,
                    status: teamAutomation.status,
                    automation: teamAutomation.automation,
                };
            });
    }
}
