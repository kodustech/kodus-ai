import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { IAutomation } from '@/core/domain/automation/interfaces/automation.interface';
import { ITeamAutomation } from '@/core/domain/automation/interfaces/team-automation.interface';
import { Inject, Injectable } from '@nestjs/common';
import { CommunicationService } from '../../../platformIntegration/communication.service';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import { CHECKIN_TYPE } from '@/core/domain/checkinHistory/enums/checkin-type.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IAutomationDailyCheckinService } from '@/core/domain/automation/contracts/automation-dailycheckin.service';
import { IAutomationFactory } from '@/core/domain/automation/contracts/processAutomation/automation.factory';
import {
    CHECKIN_SERVICE_TOKEN,
    ICheckinService,
} from '@/core/domain/checkins/contracts/checkin.service.contract';
import { CheckinConfigValue } from '@/core/domain/parameters/types/configValue.type';
import {
    PARAMETERS_SERVICE_TOKEN,
    IParametersService,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { ITeam } from '@/core/domain/team/interfaces/team.interface';
import { ValidateCommunicationManagementIntegration } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';
import { PinoLoggerService } from '../../../logger/pino.service';

@Injectable()
export class AutomationDailyCheckinService
    implements Omit<IAutomationFactory, 'stop'>, IAutomationDailyCheckinService
{
    automationType = AutomationType.AUTOMATION_DAILY_CHECKIN;
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

    async setup(payload?: any): Promise<any> {
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
            console.log('Error creating automation for the team', error);
        }
    }

    @ValidateCommunicationManagementIntegration()
    async run(payload: {
        organizationAndTeamData: OrganizationAndTeamData;
        teamAutomationId: string;
        todayDate?: Date;
        channelId?: string;
        origin?: string;
        checkinConfig: CheckinConfigValue;
        team: Partial<ITeam>;
    }): Promise<any> {
        try {
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

            this.communicationService.saveCheckinHistory({
                organizationAndTeamData: payload.organizationAndTeamData,
                date: new Date(),
                message: checkin.notification,
                sectionDataItems: checkin.sectionDataItems,
                type: CHECKIN_TYPE.DAILY,
            });

            const channel = await this.communicationService.getTeamChannelId(
                payload.organizationAndTeamData,
            );

            if ((channel || payload.channelId) && checkin) {
                this.communicationService.newBlockMessage({
                    organizationAndTeamData: payload.organizationAndTeamData,
                    blocks: checkin.notification,
                    channelId: payload.channelId ?? channel,
                });
            }

            this.createAutomationExecution(
                {
                    channelIds: channel,
                    organizationId:
                        payload.organizationAndTeamData.organizationId,
                },
                payload.teamAutomationId,
                payload.origin,
            );

            return 'Automation executed successfully';
        } catch (error) {
            console.log(error);
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
                config.checkinId === 'daily-checkin',
        );
    }
}
