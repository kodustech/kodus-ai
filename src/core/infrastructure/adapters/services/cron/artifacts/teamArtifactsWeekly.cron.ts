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
    IntegrationMatchType,
    IntegrationStatusFilter,
} from '@/core/domain/team/interfaces/team.interface';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

const API_CRON_TEAM_ARTIFACTS_WEEKLY =
    process.env.API_CRON_TEAM_ARTIFACTS_WEEKLY;

@Injectable()
export class WeeklyTeamArtifactsProvider {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN) private readonly teamService: ITeamService,

        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_TEAM_ARTIFACTS_WEEKLY, {
        name: 'Weekly Team Artifacts',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            console.log('STARTING CRON - EXECUTING TEAM WEEKLY ARTIFACTS');

            const teams = await this.teamService.findTeamsWithIntegrations({
                status: STATUS.ACTIVE,
                integrationCategories: [
                    IntegrationCategory.CODE_MANAGEMENT,
                    IntegrationCategory.PROJECT_MANAGEMENT,
                ],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                matchType: IntegrationMatchType.SOME,
            });

            for (const team of teams) {
                const task = {
                    teamId: team.uuid,
                    organizationId: team.organization.uuid,
                };

                const runWeeklyPayload =
                    this.messageBroker.transformMessageToMessageBroker(
                        'cron.artifact.runTeamArtifactWeekly',
                        task,
                    );
                await this.messageBroker.publishMessage(
                    {
                        exchange: 'orchestrator.exchange.delayed',
                        routingKey: 'artifact.runTeamArtifactWeekly',
                    },
                    runWeeklyPayload,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error while executing team artifacts',
                context: WeeklyTeamArtifactsProvider.name,
                error: error,
            });
        }
    }
}
