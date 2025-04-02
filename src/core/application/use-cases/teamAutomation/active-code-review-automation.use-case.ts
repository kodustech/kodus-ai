import { Inject, Injectable } from '@nestjs/common';
import {
    AutomationType,
} from '@/core/domain/automation/enums/automation-type';
import { REQUEST } from '@nestjs/core';
import { UpdateTeamAutomationStatusUseCase } from './updateTeamAutomationStatusUseCase';
import { ITeamAutomationService, TEAM_AUTOMATION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/team-automation.service';

interface IAutomation {
    automationUuid: string;
    automationType: AutomationType;
    status: boolean;
}

@Injectable()
export class ActiveCodeReviewAutomationUseCase {
    constructor(
        private readonly updateTeamAutomationStatusUseCase: UpdateTeamAutomationStatusUseCase,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) { }

    async execute(teamId: string, codeManagementTeamAutomations: IAutomation[]) {
        const codeReviewAutomation = codeManagementTeamAutomations.find((automation) =>
            automation.automationType === AutomationType.AUTOMATION_CODE_REVIEW,
        );

        const [teamAutomation] = await this.teamAutomationService.find({
            team: { uuid: teamId },
            automation: { uuid: codeReviewAutomation.automationUuid }
        })

        await this.updateTeamAutomationStatusUseCase.execute(teamAutomation.uuid, true);
    }
}
