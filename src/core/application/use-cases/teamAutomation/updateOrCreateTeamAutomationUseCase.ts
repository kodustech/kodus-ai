import { Inject, Injectable } from '@nestjs/common';
import {
    TEAM_AUTOMATION_SERVICE_TOKEN,
    ITeamAutomationService,
} from '@/core/domain/automation/contracts/team-automation.service';
import { TeamAutomationsDto } from '@/core/infrastructure/http/dtos/team-automation.dto';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    IProfileConfigService,
    PROFILE_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/profileConfigs/contracts/profileConfig.service.contract';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { ProfileConfigKey } from '@/core/domain/profileConfigs/enum/profileConfigKey.enum';

@Injectable()
export class UpdateOrCreateTeamAutomationUseCase {
    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(PROFILE_CONFIG_SERVICE_TOKEN)
        private readonly profileConfigService: IProfileConfigService,

        private readonly communication: CommunicationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(teamAutomations: TeamAutomationsDto, notify: boolean = true) {
        const organizationAndTeamData = this.getOrganizationAndTeamData(
            teamAutomations.teamId,
        );

        const oldTeamAutomation = await this.teamAutomationService.find({
            team: { uuid: teamAutomations.teamId },
        });

        if (!oldTeamAutomation) {
            this.setupNewAutomations(
                teamAutomations.automations,
                organizationAndTeamData,
            );
        } else {
            this.updateOrCreateAutomations(
                teamAutomations,
                oldTeamAutomation,
                organizationAndTeamData,
            );
        }

        if (notify) {
            await this.notifyTeamIfNeeded(
                organizationAndTeamData,
                teamAutomations,
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

    private setupNewAutomations(
        automations: TeamAutomationsDto['automations'],
        organizationAndTeamData: any,
    ) {
        for (const automation of automations) {
            this.executeAutomation.setupStrategy(
                automation?.automationType,
                organizationAndTeamData,
            );
        }
    }

    private updateOrCreateAutomations(
        teamAutomations: TeamAutomationsDto,
        oldTeamAutomation: any[],
        organizationAndTeamData: any,
    ) {
        for (const automation of teamAutomations.automations) {
            const existingAutomation = oldTeamAutomation.find(
                (old) => old.automation.uuid === automation.automationUuid,
            );

            if (existingAutomation) {
                this.teamAutomationService.update(
                    { uuid: existingAutomation.uuid },
                    {
                        uuid: existingAutomation.uuid,
                        status: existingAutomation.status,
                        team: { uuid: teamAutomations.teamId },
                        automation: { uuid: automation.automationUuid },
                    },
                );
            } else if (automation.status) {
                this.executeAutomation.setupStrategy(
                    automation.automationType,
                    organizationAndTeamData,
                );
            }
        }
    }

    private async notifyTeamIfNeeded(
        organizationAndTeamData: any,
        teamAutomations: TeamAutomationsDto,
    ) {
        const [organization, automations, teamMembers, teamChannelId] =
            await Promise.all([
                this.organizationService.findOne({
                    uuid: organizationAndTeamData.organizationId,
                }),
                this.automationService.find(),
                this.communication.getChannelIdLeaderTeam({
                    organizationAndTeamData,
                }),
                this.communication.getTeamChannelId(organizationAndTeamData),
            ]);

        const activeAutomations = this.getActiveAutomations(
            automations,
            teamAutomations,
        );

        if (teamChannelId) {
            const template = await this.communication.handlerTemplateMessage({
                methodName: 'getWelcomeMessage',
                activeAutomations,
                organizationName: organization.name,
                organizationAndTeamData,
            });

            await this.communication.newBlockMessage({
                organizationAndTeamData,
                blocks: template,
                channelId: teamChannelId,
            });
        }
    }

    private getActiveAutomations(
        automations: any[],
        teamAutomations: TeamAutomationsDto,
    ) {
        const automationActive = automations
            ?.filter((automation) =>
                teamAutomations.automations?.some(
                    (auto) =>
                        auto.automationUuid === automation.uuid && auto.status,
                ),
            )
            ?.map((automation) => automation.automationType);

        const descriptions = [
            automationActive?.includes(
                AutomationType.AUTOMATION_ISSUES_DETAILS,
            ) ||
            automationActive?.includes(AutomationType.AUTOMATION_IMPROVE_TASK)
                ? '• *Description Enhancement:* If a task description seems vague, I will help enrich it. \n\n'
                : '',
            automationActive?.includes(
                AutomationType.AUTOMATION_INTERACTION_MONITOR,
            )
                ? ' • *Activity Monitoring:* If an activity remains idle for too long, I will remind you to avoid delays. \n\n'
                : '',
            automationActive?.includes(AutomationType.AUTOMATION_TEAM_PROGRESS)
                ? ' • *Delivery Summaries*: Want a quick overview of our delivery status? I will send concise weekly updates on how things are progressing.'
                : '',
        ];

        return descriptions.filter(Boolean).join('');
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
