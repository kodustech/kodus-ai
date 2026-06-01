import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';

import { UpdateTeamAutomationStatusUseCase } from './updateTeamAutomationStatusUseCase';

interface IAutomation {
    automationUuid: string;
    automationType: AutomationType;
    status: boolean;
}

@Injectable()
export class ActiveCodeReviewAutomationUseCase implements IUseCase {
    constructor(
        private readonly updateTeamAutomationStatusUseCase: UpdateTeamAutomationStatusUseCase,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(
        teamId: string,
        codeManagementTeamAutomations: IAutomation[],
    ) {
        const codeReviewAutomation = codeManagementTeamAutomations?.find(
            (automation) =>
                automation.automationType ===
                AutomationType.AUTOMATION_CODE_REVIEW,
        );

        if (!codeReviewAutomation?.automationUuid) {
            return;
        }

        const results = await this.teamAutomationService.find({
            team: { uuid: teamId },
            automation: { uuid: codeReviewAutomation.automationUuid },
        });

        const [teamAutomation] = results ?? [];

        if (teamAutomation) {
            await this.updateTeamAutomationStatusUseCase.execute(
                teamAutomation.uuid,
                true,
            );
        }
    }
}
