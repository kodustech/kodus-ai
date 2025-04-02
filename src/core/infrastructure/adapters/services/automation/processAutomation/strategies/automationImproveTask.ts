import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { IAutomationFactory } from '@/core/domain/automation/contracts/processAutomation/automation.factory';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { IAutomation } from '@/core/domain/automation/interfaces/automation.interface';
import { ITeamAutomation } from '@/core/domain/automation/interfaces/team-automation.interface';

import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class AutomationImproveTaskService implements IAutomationFactory {
    automationType = AutomationType.AUTOMATION_IMPROVE_TASK;

    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,
    ) {}

    async setup(payload?: any): Promise<any> {
        try {
            const automation: IAutomation =
                await this.automationService.findOne({
                    automationType: this.automationType,
                });

            const teamAutomation: ITeamAutomation = {
                status: true,
                automation: {
                    uuid: automation.uuid,
                },
                team: {
                    uuid: payload.teamId,
                },
            };

            return this.teamAutomationService.register(teamAutomation);
        } catch (error) {
            console.log('Error creating automation for the team', error);
        }
    }

    async stop(payload?: any): Promise<any> {
        try {
            const automation: IAutomation =
                await this.automationService.findOne({
                    automationType: this.automationType,
                });

            return await this.teamAutomationService.update(
                {
                    team: { uuid: payload.teamId },
                    automation: { uuid: automation.uuid },
                },
                {
                    status: false,
                },
            );
        } catch (error) {
            console.log('Error', error);
        }
    }
}
