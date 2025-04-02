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

const API_CRON_ENRICH_TEAM_ARTIFACTS_WEEKLY =
    process.env.API_CRON_ENRICH_TEAM_ARTIFACTS_WEEKLY;

@Injectable()
export class WeeklyEnrichTeamArtifactsProvider {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN) private readonly teamService: ITeamService,

        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_ENRICH_TEAM_ARTIFACTS_WEEKLY, {
        name: 'Weekly Enrich Team Artifacts',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            console.log(
                'STARTING CRON - EXECUTING ENRICH TEAM WEEKLY ARTIFACTS',
            );

            const teams = await this.teamService.findTeamsWithIntegrations({
                status: STATUS.ACTIVE,
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                integrationCategories: [
                    IntegrationCategory.PROJECT_MANAGEMENT,
                    IntegrationCategory.CODE_MANAGEMENT,
                ],
                matchType: IntegrationMatchType.SOME,
            });

            for (const team of teams) {
                const task = {
                    teamId: team.uuid,
                    organizationId: team.organization.uuid,
                    isProjectManagementConfigured:
                        team.isProjectManagementConfigured || false,
                    isCodeManagementConfigured:
                        team.isCodeManagementConfigured || false,
                };

                const runWeeklyPayload =
                    this.messageBroker.transformMessageToMessageBroker(
                        'cron.artifact.runEnrichTeamArtifactWeekly',
                        task,
                    );
                await this.messageBroker.publishMessage(
                    {
                        exchange: 'orchestrator.exchange.delayed',
                        routingKey: 'artifact.runEnrichTeamArtifactWeekly',
                    },
                    runWeeklyPayload,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error while executing team artifacts',
                context: WeeklyEnrichTeamArtifactsProvider.name,
                error: error,
            });
        }
    }
}
