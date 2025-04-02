import { IAutomationFactory } from '@/core/domain/automation/contracts/processAutomation/automation.factory';
import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { ITeamAutomation } from '@/core/domain/automation/interfaces/team-automation.interface';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { IAutomation } from '@/core/domain/automation/interfaces/automation.interface';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import { CommunicationService } from '../../../platformIntegration/communication.service';
import { CHECKIN_TYPE } from '@/core/domain/checkinHistory/enums/checkin-type.enum';
import { PinoLoggerService } from '../../../logger/pino.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IAutomationWeeklyCheckinService } from '@/core/domain/automation/contracts/automation_weeklyCheckin.service';
import {
    CHECKIN_SERVICE_TOKEN,
    ICheckinService,
} from '@/core/domain/checkins/contracts/checkin.service.contract';
import { CheckinConfigValue } from '@/core/domain/parameters/types/configValue.type';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { ITeam } from '@/core/domain/team/interfaces/team.interface';
import { ValidateCommunicationManagementIntegration } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';

@Injectable()
export class AutomationTeamProgressService
    implements IAutomationFactory, IAutomationWeeklyCheckinService
{
    automationType = AutomationType.AUTOMATION_TEAM_PROGRESS;

    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(CHECKIN_SERVICE_TOKEN)
        private readonly checkinService: ICheckinService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly communicationService: CommunicationService,

        private readonly logger: PinoLoggerService,
    ) {}

    async setup(payload?: { teamId: string }): Promise<any> {
        try {
            // Fetch automation ID
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )[0];

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
            this.logger.error({
                message: 'Error creating automation for the team',
                context: AutomationTeamProgressService.name,
                error: error,
                metadata: payload,
            });
        }
    }

    async stop(payload?: { teamId: string }): Promise<any> {
        try {
            // Fetch automation ID
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )[0];

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
            this.logger.error({
                message: 'Error deactivating automation for the team',
                context: AutomationTeamProgressService.name,
                error: error,
                metadata: payload,
            });
        }
    }

    @ValidateCommunicationManagementIntegration()
    async run(payload?: {
        organizationAndTeamData: OrganizationAndTeamData;
        teamAutomationId: string;
        checkinConfig: CheckinConfigValue;
        channelId?: string;
        origin: string;
        team: Partial<ITeam>;
    }): Promise<any> {
        try {
            const teamChannelId =
                await this.communicationService.getTeamChannelId(
                    payload.organizationAndTeamData,
                );

            if (!payload.checkinConfig) {
                payload.checkinConfig = await this.getCheckinConfig(
                    payload.organizationAndTeamData,
                );
            }

            if (!payload.checkinConfig) {
                return;
            }

            const checkin = await this.checkinService.generate({
                organizationAndTeamData: payload.organizationAndTeamData,
                checkinConfig: payload.checkinConfig,
                team: payload.team,
            });

            await this.communicationService.saveCheckinHistory({
                date: new Date(),
                message: checkin.notification,
                type: CHECKIN_TYPE.WEEKLY,
                sectionDataItems: checkin.sectionDataItems,
                organizationAndTeamData: payload.organizationAndTeamData,
            });

            if (teamChannelId || payload.channelId) {
                await this.communicationService.newBlockMessage({
                    organizationAndTeamData: payload.organizationAndTeamData,
                    blocks: checkin.notification,
                    channelId: payload.channelId ?? teamChannelId,
                });
                this.createAutomationExecution(
                    {
                        channelIds: teamChannelId,
                        organizationId:
                            payload.organizationAndTeamData.organizationId,
                    },
                    payload.teamAutomationId,
                    payload.origin,
                );
            }

            return 'Automation executed successfully';
        } catch (error) {
            this.logger.error({
                message: 'Error executing automation',
                context: AutomationTeamProgressService.name,
                error: error,
                metadata: {
                    organizationId:
                        payload.organizationAndTeamData.organizationId,
                    teamId: payload.organizationAndTeamData.teamId,
                },
            });
        }
    }

    private createAutomationExecution(
        data: any,
        teamAutomationId: string,
        origin: string,
    ) {
        const automationExecution = {
            status: AutomationStatus.SUCCESS,
            dataExecution: data,
            teamAutomation: { uuid: teamAutomationId },
            origin,
        };

        this.automationExecutionService.register(automationExecution);
    }

    private async getCheckinConfig(organizationAndTeamData) {
        const checkinConfigParameter = await this.parametersService.findByKey(
            ParametersKey.CHECKIN_CONFIG,
            organizationAndTeamData,
        );
        return checkinConfigParameter?.configValue.find(
            (config: CheckinConfigValue) =>
                config.checkinId === 'weekly-checkin',
        );
    }
}
