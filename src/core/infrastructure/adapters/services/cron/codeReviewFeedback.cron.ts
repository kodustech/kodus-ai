import { IMessageBrokerService } from '@/shared/domain/contracts/message-broker.service.contracts';
import { MESSAGE_BROKER_SERVICE_TOKEN } from '@/shared/domain/contracts/message-broker.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PinoLoggerService } from '../logger/pino.service';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { STATUS } from '@/config/types/database/status.type';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { IntegrationStatusFilter } from '@/core/domain/team/interfaces/team.interface';

const API_CRON_SYNC_CODE_REVIEW_REACTIONS =
    process.env.API_CRON_SYNC_CODE_REVIEW_REACTIONS;

@Injectable()
export class CodeReviewFeedbackCronProvider {
    constructor(
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        private readonly logger: PinoLoggerService,
    ) {}

    @Cron(API_CRON_SYNC_CODE_REVIEW_REACTIONS, {
        name: 'Sync Code Review Reactions',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            this.logger.log({
                message: 'Code review feedback cron started',
                context: CodeReviewFeedbackCronProvider.name,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });

            const teams = await this.teamService.findTeamsWithIntegrations({
                integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });

            for (let index = 0; index < teams.length; index++) {
                const team = teams[index];

                try {
                    await this.publishSyncCodeReviewReactionsTasks(team);

                    this.logger.log({
                        message: `Messages published for team ${team.uuid}`,
                        context: CodeReviewFeedbackCronProvider.name,
                        metadata: {
                            teamId: team.uuid,
                            timestamp: new Date().toISOString(),
                        },
                    });
                } catch (error) {
                    this.logger.error({
                        message: `Error capturing code review feedback for team ${team.uuid}`,
                        context: CodeReviewFeedbackCronProvider.name,
                        error,
                        metadata: { teamId: team.uuid },
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing code review feedback cron',
                context: CodeReviewFeedbackCronProvider.name,
            });
        }
    }

    private async publishSyncCodeReviewReactionsTasks(team) {
        let task = null;
        let runCodeReviewReactionsPayload = null;

        if (team.isCodeManagementConfigured) {
            task = {
                teamId: team.uuid,
                organizationId: team.organization.uuid,
            };

            runCodeReviewReactionsPayload =
                this.messageBroker.transformMessageToMessageBroker(
                    'cron.codeReviewFeedback.syncCodeReviewReactions',
                    task,
                );
            await this.messageBroker.publishMessage(
                {
                    exchange: 'orchestrator.exchange.delayed',
                    routingKey: 'codeReviewFeedback.syncCodeReviewReactions',
                },
                runCodeReviewReactionsPayload,
            );
        }

        this.logger.debug({
            message: `Payloads published for team ${team.uuid}`,
            context: CodeReviewFeedbackCronProvider.name,
            metadata: {
                runCodeReviewReactionsPayload,
                timestamp: new Date().toISOString(),
            },
        });
    }
}
