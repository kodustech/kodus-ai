import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { Injectable, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PinoLoggerService } from '../../logger/pino.service';
import { STATUS } from '@/config/types/database/status.type';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@/shared/domain/contracts/message-broker.service.contracts';
import {
    IntegrationStatusFilter,
    IntegrationMatchType,
} from '@/core/domain/team/interfaces/team.interface';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

const API_CRON_TEAM_ARTIFACTS_DAILY = process.env.API_CRON_TEAM_ARTIFACTS_DAILY;

@Injectable()
export class DailyTeamArtifactsProvider {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN) private readonly teamService: ITeamService,

        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_TEAM_ARTIFACTS_DAILY, {
        name: 'Daily Team Artifacts',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            console.log('STARTING CRON - EXECUTING TEAM DAILY ARTIFACTS');

            const teams = await this.teamService.findTeamsWithIntegrations({
                status: STATUS.ACTIVE,
                integrationCategories: [IntegrationCategory.PROJECT_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                matchType: IntegrationMatchType.EVERY,
            });

            for (const team of teams) {
                const task = {
                    teamId: team.uuid,
                    organizationId: team.organization.uuid,
                };

                const runDailyPayload =
                    this.messageBroker.transformMessageToMessageBroker(
                        'cron.artifact.runTeamArtifactDaily',
                        task,
                    );
                await this.messageBroker.publishMessage(
                    {
                        exchange: 'orchestrator.exchange.delayed',
                        routingKey: 'artifact.runTeamArtifactDaily',
                    },
                    runDailyPayload,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error while executing team artifacts',
                context: DailyTeamArtifactsProvider.name,
                error: error,
            });
        }
    }
}
