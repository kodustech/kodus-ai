import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PinoLoggerService } from '../logger/pino.service';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@/shared/domain/contracts/message-broker.service.contracts';

const API_CRON_ORGANIZATION_METRICS = process.env.API_CRON_ORGANIZATION_METRICS;

@Injectable()
export class OrganizationMetricsCronProvider {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_ORGANIZATION_METRICS, {
        name: 'Daily Organization Metrics',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            const organizations = await this.organizationService.find({
                status: true,
            });

            if (!organizations || organizations.length <= 0) {
                return;
            }

            await Promise.all(
                organizations.map(async (organization) => {
                    try {
                        const task = {
                            organizationId: organization.uuid,
                        };

                        const organizationMetricsPayload =
                            this.messageBroker.transformMessageToMessageBroker(
                                'cron.metrics.runOrganizationMetrics',
                                task,
                            );

                        await this.messageBroker.publishMessage(
                            {
                                exchange: 'orchestrator.exchange.delayed',
                                routingKey: 'metrics.runOrganizationMetrics',
                            },
                            organizationMetricsPayload,
                        );
                    } catch (error) {
                        this.logger.error({
                            message: `Error processing metrics for organization ${organization.uuid}`,
                            context: OrganizationMetricsCronProvider.name,
                            error,
                            metadata: { organizationId: organization.uuid },
                        });
                    }
                }),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error executing daily organization metrics',
                context: OrganizationMetricsCronProvider.name,
                error,
            });
        }
    }
}
