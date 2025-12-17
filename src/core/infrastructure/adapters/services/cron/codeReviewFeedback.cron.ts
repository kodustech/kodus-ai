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
import {
    IntegrationStatusFilter,
    ITeamWithIntegrations,
} from '@/core/domain/team/interfaces/team.interface';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';

const API_CRON_SYNC_CODE_REVIEW_REACTIONS =
    process.env.API_CRON_SYNC_CODE_REVIEW_REACTIONS;

@Injectable()
export class CodeReviewFeedbackCronProvider {
    constructor(
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

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

            if (!teams?.length) {
                this.logger.log({
                    message: 'No active teams with code management found',
                    context: CodeReviewFeedbackCronProvider.name,
                });
                return;
            }

            const codeReviewAutomation = await this.automationService.find({
                automationType: AutomationType.AUTOMATION_CODE_REVIEW,
            });

            if (!codeReviewAutomation?.[0]) {
                this.logger.warn({
                    message: 'No code review automation found',
                    context: CodeReviewFeedbackCronProvider.name,
                });
                return;
            }

            const automationUuid = codeReviewAutomation[0].uuid;
            const threeDaysAgo = new Date();
            threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
            const now = new Date();

            const teamAutomationsResults = await Promise.allSettled(
                teams.map((team) =>
                    this.teamAutomationService
                        .find({
                            team: { uuid: team.uuid },
                            automation: { uuid: automationUuid },
                        })
                        .then((automations) => ({
                            team,
                            teamAutomation: automations?.[0],
                        })),
                ),
            );

            const teamsWithAutomation = teamAutomationsResults
                .filter(
                    (result) =>
                        result.status === 'fulfilled' &&
                        !!result.value.teamAutomation,
                )
                .map((result) => {
                    if (result.status === 'fulfilled') {
                        return result.value;
                    }
                    throw new Error('Unexpected rejected result');
                });

            if (!teamsWithAutomation.length) {
                this.logger.log({
                    message: 'No teams with automation found',
                    context: CodeReviewFeedbackCronProvider.name,
                });
                return;
            }

            const executionsResults = await Promise.allSettled(
                teamsWithAutomation.map(({ team, teamAutomation }) =>
                    this.automationExecutionService
                        .findByPeriodAndTeamAutomationId(
                            threeDaysAgo,
                            now,
                            teamAutomation.uuid,
                            AutomationStatus.SUCCESS,
                        )
                        .then((executions) => ({
                            team,
                            executions,
                        })),
                ),
            );

            const teamsToProcess = executionsResults
                .filter(
                    (result) =>
                        result.status === 'fulfilled' &&
                        result.value.executions?.length > 0,
                )
                .map((result) => {
                    if (result.status === 'fulfilled') {
                        return result.value;
                    }
                    throw new Error('Unexpected rejected result');
                });

            if (!teamsToProcess.length) {
                this.logger.log({
                    message:
                        'No teams with successful executions in the last 3 days',
                    context: CodeReviewFeedbackCronProvider.name,
                });
                return;
            }

            const publishResults = await Promise.allSettled(
                teamsToProcess.map(async ({ team, executions }) => {
                    const automationExecutionsPRs = executions
                        .map(
                            (execution) =>
                                execution?.dataExecution?.pullRequestNumber,
                        )
                        .filter(
                            (prNumber): prNumber is number =>
                                prNumber !== undefined && prNumber !== null,
                        );

                    if (!automationExecutionsPRs.length) {
                        this.logger.warn({
                            message: `Team has executions but no valid PR numbers`,
                            context: CodeReviewFeedbackCronProvider.name,
                            metadata: {
                                teamId: team.uuid,
                                executionsCount: executions.length,
                            },
                        });
                        throw new Error('No valid PR numbers found');
                    }

                    await this.publishSyncCodeReviewReactionsTasks(
                        team,
                        automationExecutionsPRs,
                    );

                    return {
                        team,
                        executionsCount: executions.length,
                    };
                }),
            );

            publishResults.forEach((result) => {
                if (result.status === 'fulfilled') {
                    this.logger.log({
                        message: `Message published for team ${result.value.team.uuid}`,
                        context: CodeReviewFeedbackCronProvider.name,
                        metadata: {
                            teamId: result.value.team.uuid,
                            executionsCount: result.value.executionsCount,
                            timestamp: new Date().toISOString(),
                        },
                    });
                } else {
                    this.logger.error({
                        message: 'Error publishing message for team',
                        context: CodeReviewFeedbackCronProvider.name,
                        error: result.reason,
                    });
                }
            });

            const successfulPublishes = publishResults.filter(
                (r) => r.status === 'fulfilled',
            );

            const processedOrganizations = successfulPublishes.map(
                (result) => ({
                    organizationId: result.value.team.organization.uuid,
                    teamId: result.value.team.uuid,
                    executionsCount: result.value.executionsCount,
                }),
            );

            this.logger.log({
                message: 'Code review feedback cron completed',
                context: CodeReviewFeedbackCronProvider.name,
                metadata: {
                    totalTeams: teams.length,
                    teamsWithAutomation: teamsWithAutomation.length,
                    teamsProcessed: teamsToProcess.length,
                    tasksPublished: successfulPublishes.length,
                    processedOrganizations,
                    timestamp: new Date().toISOString(),
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error executing code review feedback cron',
                context: CodeReviewFeedbackCronProvider.name,
                error,
            });
        }
    }

    private async publishSyncCodeReviewReactionsTasks(
        team: ITeamWithIntegrations,
        automationExecutionsPRs: number[],
    ) {
        if (!team.isCodeManagementConfigured) {
            this.logger.debug({
                message: `Code management not configured for team ${team.uuid}`,
                context: CodeReviewFeedbackCronProvider.name,
                metadata: { teamId: team.uuid },
            });
            return;
        }

        const task = {
            teamId: team.uuid,
            organizationId: team.organization.uuid,
            automationExecutionsPRs,
        };

        const runCodeReviewReactionsPayload =
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

        this.logger.debug({
            message: `Payload published for team ${team.uuid}`,
            context: CodeReviewFeedbackCronProvider.name,
            metadata: {
                payload: runCodeReviewReactionsPayload,
                timestamp: new Date().toISOString(),
            },
        });
    }
}
