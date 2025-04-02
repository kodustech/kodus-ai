import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PinoLoggerService } from '../logger/pino.service';
import { STATUS } from '@/config/types/database/status.type';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@/shared/domain/contracts/message-broker.service.contracts';
import { IntegrationStatusFilter } from '@/core/domain/team/interfaces/team.interface';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

const API_CRON_METRICS = process.env.API_CRON_METRICS;

@Injectable()
export class MetricsCronProvider {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_METRICS, {
        name: 'Daily Metrics',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            this.logger.log({
                message: 'Metrics cron job started',
                context: MetricsCronProvider.name,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });

            const teams = await this.teamService.findTeamsWithIntegrations({
                integrationCategories: [
                    IntegrationCategory.CODE_MANAGEMENT,
                    IntegrationCategory.PROJECT_MANAGEMENT,
                ],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });

            for (let index = 0; index < teams.length; index++) {
                const team = teams[index];

                try {
                    // Publish metrics for the current team
                    await this.publishMetricsTasks(team);

                    // Log to indicate that the messages were published
                    this.logger.log({
                        message: `Messages published for team ${team.uuid}`,
                        context: MetricsCronProvider.name,
                        metadata: {
                            teamId: team.uuid,
                            timestamp: new Date().toISOString(),
                        },
                    });
                } catch (error) {
                    // Capture the error specific to the current team
                    this.logger.error({
                        message: `Error processing metrics for team ${team.uuid}`,
                        context: MetricsCronProvider.name,
                        error,
                        metadata: { teamId: team.uuid },
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing daily metrics',
                context: MetricsCronProvider.name,
                error,
            });
        }

        this.logger.log({
            message: 'Metrics Cron Job completed',
            context: MetricsCronProvider.name,
            metadata: {
                timestamp: new Date().toISOString(),
            },
        });
    }

    private async publishMetricsTasks(team) {
        let taskProjectManagement = null;
        let taskCodeManagement = null;
        let runFlowDailyPayload = null;
        let runDoraDailyPayload = null;

        if (team.isProjectManagementConfigured) {
            taskProjectManagement = {
                teamId: team.uuid,
                organizationId: team.organization.uuid,
            };

            runFlowDailyPayload =
                this.messageBroker.transformMessageToMessageBroker(
                    'cron.metrics.runFlowDaily',
                    taskProjectManagement,
                );
            await this.messageBroker.publishMessage(
                {
                    exchange: 'orchestrator.exchange.delayed',
                    routingKey: 'metrics.runFlowDaily',
                },
                runFlowDailyPayload,
            );
        }

        if (team.isCodeManagementConfigured) {
            taskCodeManagement = {
                teamId: team.uuid,
                organizationId: team.organization.uuid,
            };

            runDoraDailyPayload =
                this.messageBroker.transformMessageToMessageBroker(
                    'cron.metrics.runDoraDaily',
                    taskCodeManagement,
                );
            await this.messageBroker.publishMessage(
                {
                    exchange: 'orchestrator.exchange.delayed',
                    routingKey: 'metrics.runDoraDaily',
                },
                runDoraDailyPayload,
            );
        }

        this.logger.debug({
            message: `Payloads published for team ${team.uuid}`,
            context: MetricsCronProvider.name,
            metadata: {
                runFlowDailyPayload,
                runDoraDailyPayload,
                timestamp: new Date().toISOString(),
            },
        });
    }
}
