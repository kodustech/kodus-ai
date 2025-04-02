import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import { PinoLoggerService } from '../../logger/pino.service';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@/shared/domain/contracts/message-broker.service.contracts';

const API_CRON_ORGANIZATION_ARTIFACTS_WEEKLY =
    process.env.API_CRON_ORGANIZATION_ARTIFACTS_WEEKLY;

@Injectable()
export class WeeklyOrganizationArtifactsProvider {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_ORGANIZATION_ARTIFACTS_WEEKLY, {
        name: 'Weekly Organization Artifacts',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            console.log(
                'STARTING CRON - EXECUTING Organization WEEKLY ARTIFACTS',
            );
            const organizations = await this.organizationService.find({
                status: true,
            });

            for (const organization of organizations) {
                const task = {
                    organizationId: organization.uuid,
                };

                const runWeeklyPayload =
                    this.messageBroker.transformMessageToMessageBroker(
                        'cron.artifact.runOrganizationArtifactWeekly',
                        task,
                    );
                await this.messageBroker.publishMessage(
                    {
                        exchange: 'orchestrator.exchange.delayed',
                        routingKey: 'artifact.runOrganizationArtifactWeekly',
                    },
                    runWeeklyPayload,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing organization artifacts',
                context: WeeklyOrganizationArtifactsProvider.name,
                error: error,
            });
        }
    }
}
