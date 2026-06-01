import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@libs/automation/domain/automationExecution/contracts/execute.automation.service.contracts';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { TeamAutomationsDto } from '@libs/automation/infrastructure/http/dtos/team-automation.dto';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IProfileConfigService,
    PROFILE_CONFIG_SERVICE_TOKEN,
} from '@libs/identity/domain/profile-configs/contracts/profileConfig.service.contract';
import { ProfileConfigKey } from '@libs/identity/domain/profile-configs/enum/profileConfigKey.enum';

@Injectable()
export class UpdateOrCreateTeamAutomationUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        @Inject(PROFILE_CONFIG_SERVICE_TOKEN)
        private readonly profileConfigService: IProfileConfigService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(teamAutomations: TeamAutomationsDto) {
        const organizationAndTeamData = this.getOrganizationAndTeamData(
            teamAutomations.teamId,
        );

        const oldTeamAutomation = await this.teamAutomationService.find({
            team: { uuid: teamAutomations.teamId },
        });

        // `find` always resolves to an array, so a fresh team yields `[]`.
        // Treat an empty (or missing) result as "no automations yet" so it
        // still flows into `setupNewAutomations`, as the falsy check intended.
        if (!oldTeamAutomation?.length) {
            await this.setupNewAutomations(
                teamAutomations.automations,
                organizationAndTeamData,
            );
        } else {
            await this.updateOrCreateAutomations(
                teamAutomations,
                oldTeamAutomation,
                organizationAndTeamData,
            );
        }

        return await this.addProfileConfigServiceToTeamMembers();
    }

    private getOrganizationAndTeamData(teamId: string) {
        return {
            organizationId: this.request.user?.organization?.uuid,
            teamId,
        };
    }

    private async setupNewAutomations(
        automations: TeamAutomationsDto['automations'],
        organizationAndTeamData: any,
    ) {
        // Awaited so the team_automation rows are committed before `execute`
        // returns. Callers (registerRepo -> ActiveCodeReviewAutomationUseCase)
        // depend on those rows existing to flip the automation to active.
        for (const automation of automations) {
            await this.executeAutomation.setupStrategy(
                automation?.automationType,
                organizationAndTeamData,
            );
        }
    }

    private async updateOrCreateAutomations(
        teamAutomations: TeamAutomationsDto,
        oldTeamAutomation: any[],
        organizationAndTeamData: any,
    ) {
        // Index by automation uuid so the lookup below is O(1). `set` only when
        // absent keeps the first-match semantics of the previous `.find()`.
        const existingByAutomationUuid = new Map<string, any>();
        for (const old of oldTeamAutomation) {
            if (!existingByAutomationUuid.has(old.automation.uuid)) {
                existingByAutomationUuid.set(old.automation.uuid, old);
            }
        }

        for (const automation of teamAutomations.automations) {
            const existingAutomation = existingByAutomationUuid.get(
                automation.automationUuid,
            );

            if (existingAutomation) {
                await this.teamAutomationService.update(
                    { uuid: existingAutomation.uuid },
                    {
                        uuid: existingAutomation.uuid,
                        status: existingAutomation.status,
                        team: { uuid: teamAutomations.teamId },
                        automation: { uuid: automation.automationUuid },
                    },
                );
            } else if (automation.status) {
                await this.executeAutomation.setupStrategy(
                    automation.automationType,
                    organizationAndTeamData,
                );
            }
        }
    }

    private async addProfileConfigServiceToTeamMembers() {
        const profileConfigService = await this.profileConfigService.findOne({
            configKey: ProfileConfigKey.USER_NOTIFICATIONS,
        });

        if (!profileConfigService) {
            return 'Team members not found';
        }

        return {
            id: profileConfigService.configValue.communicationId,
            name: profileConfigService.configValue.name,
        };
    }
}
