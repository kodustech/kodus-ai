import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import {
    IOrganizationAutomationService,
    ORGANIZATION_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/organization-automation.service';

@Injectable()
export class RunOrganizationAutomationsUseCase {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(ORGANIZATION_AUTOMATION_SERVICE_TOKEN)
        private readonly organizationAutomationService: IOrganizationAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        private readonly communication: CommunicationService,

        private logger: PinoLoggerService,
    ) {}

    async execute(params: {
        organizationId: string;
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
                    context: RunOrganizationAutomationsUseCase.name,
                    metadata: {
                        automationName: params.automationName,
                    },
                });
                throw new Error('No automation found');
            }

            const organizationAutomations =
                await this.organizationAutomationService.find({
                    automation: { uuid: automation.uuid },
                    status: true,
                    organization: { uuid: params.organizationId },
                });

            if (!organizationAutomations) {
                this.logger.warn({
                    message: 'No organization-level automation found enabled',
                    context: RunOrganizationAutomationsUseCase.name,
                    metadata: {
                        automation: automation.uuid,
                        teamId: params.automationName,
                    },
                });
                new Error('No organization-level automation found enabled');

                if (params && params.channelId && params.organizationId) {
                    this.sendErrorMessageTemplate(
                        params.organizationId,
                        params.channelId,
                    );
                }
            }

            for (const organizationAutomation of organizationAutomations) {
                return await this.executeAutomation.executeStrategy(
                    params.automationName,
                    {
                        organizationId: params.organizationId,
                        organizationAutomationId: organizationAutomation.uuid,
                        channelId: params.channelId,
                        origin: params.origin,
                    },
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing weekly progress automation',
                context: RunOrganizationAutomationsUseCase.name,
                error: error,
                metadata: {
                    automationName: params.automationName,
                    organizationId: params.organizationId,
                    channelId: params.channelId,
                },
            });
        }
    }

    private async sendErrorMessageTemplate(
        organizationId: string,
        channelId: string,
    ): Promise<any> {
        const template = await this.communication.handlerTemplateMessage({
            methodName: 'getDefaultMessageErrorProcessCommands',
            organizationId: organizationId,
            errorMessage:
                'No information found at the moment for processing the metrics.',
        });

        await this.communication.newBlockMessage({
            organizationId,
            blocks: template,
            channelId: channelId,
        });
    }
}
