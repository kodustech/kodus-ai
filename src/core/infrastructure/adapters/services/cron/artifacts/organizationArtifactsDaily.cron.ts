import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PinoLoggerService } from '../../logger/pino.service';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@/shared/domain/contracts/message-broker.service.contracts';

const API_CRON_ORGANIZATION_ARTIFACTS_DAILY =
    process.env.API_CRON_ORGANIZATION_ARTIFACTS_DAILY;

@Injectable()
export class DailyOrganizationArtifactsProvider {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_ORGANIZATION_ARTIFACTS_DAILY, {
        name: 'Daily Organization Artifacts',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            console.log(
                'STARTING CRON - EXECUTING Organization DAILY ARTIFACTS',
            );
            const organizations = await this.organizationService.find({
                status: true,
            });

            for (const organization of organizations) {
                const task = {
                    organizationId: organization.uuid,
                };

                const runDailyPayload =
                    this.messageBroker.transformMessageToMessageBroker(
                        'cron.artifact.runOrganizationArtifactDaily',
                        task,
                    );
                await this.messageBroker.publishMessage(
                    {
                        exchange: 'orchestrator.exchange.delayed',
                        routingKey: 'artifact.runOrganizationArtifactDaily',
                    },
                    runDailyPayload,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error while executing organization artifacts',
                context: DailyOrganizationArtifactsProvider.name,
                error: error,
            });
        }
    }
}
