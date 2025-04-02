import { Inject, Injectable } from '@nestjs/common';
import {
    TEAM_AUTOMATION_SERVICE_TOKEN,
    ITeamAutomationService,
} from '@/core/domain/automation/contracts/team-automation.service';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class UpdateTeamAutomationStatusUseCase {
    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(teamAutomationId: string, status: boolean) {
        const teamAutomation = await this.teamAutomationService.update(
            {
                uuid: teamAutomationId,
            },
            {
                status: status,
            },
        );

        return teamAutomation;
    }
}
