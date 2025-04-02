import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    TEAM_AUTOMATION_SERVICE_TOKEN,
    ITeamAutomationService,
} from '@/core/domain/automation/contracts/team-automation.service';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class RunTeamAutomationsUseCase {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        private readonly communication: CommunicationService,

        private logger: PinoLoggerService,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        automationName: AutomationType;
        channelId?: string;
        origin: string;
    }) {
        try {
            const automation = (
                await this.automationService.find({
                    automationType: params.automationName,
                })
            )[0];

            if (!automation) {
                this.logger.warn({
                    message: 'No automation found',
                    context: RunTeamAutomationsUseCase.name,
                    metadata: {
                        automationName: params.automationName,
                    },
                });
                throw new Error('No automation found');
            }

            const teamAutomations = await this.teamAutomationService.find({
                automation: { uuid: automation.uuid },
                status: true,
                team: { uuid: params.organizationAndTeamData.teamId },
            });

            if (!teamAutomations) {
                this.logger.warn({
                    message: 'No active team automation found',
                    context: RunTeamAutomationsUseCase.name,
                    metadata: {
                        automation: automation.uuid,
                        teamId: params.automationName,
                    },
                });
                new Error('No active team automation found');

                if (
                    params &&
                    params.channelId &&
                    params.organizationAndTeamData.organizationId
                ) {
                    this.sendErrorMessageTemplate(
                        params.organizationAndTeamData,
                        params.channelId,
                    );
                }
            }

            for (const teamAutomation of teamAutomations) {
                return await this.executeAutomation.executeStrategy(
                    params.automationName,
                    {
                        organizationAndTeamData: params.organizationAndTeamData,
                        teamAutomationId: teamAutomation.uuid,
                        channelId: params.channelId,
                        origin: params.origin,
                    },
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing weekly progress automation',
                context: RunTeamAutomationsUseCase.name,
                error: error,
                metadata: {
                    automationName: params.automationName,
                    teamId: params.organizationAndTeamData.teamId,
                    channelId: params.channelId,
                },
            });
        }
    }

    private async sendErrorMessageTemplate(
        organizationAndTeamData: OrganizationAndTeamData,
        channelId: string,
    ): Promise<any> {
        const template = await this.communication.handlerTemplateMessage({
            methodName: 'getDefaultMessageErrorProcessCommands',
            organizationId: organizationAndTeamData.organizationId,
            errorMessage:
                'No information found at the moment for processing metrics.',
        });

        await this.communication.newBlockMessage({
            organizationAndTeamData,
            blocks: template,
            channelId: channelId,
        });
    }
}
