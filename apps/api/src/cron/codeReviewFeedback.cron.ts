import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import pLimit from 'p-limit';

import { IMessageBrokerService } from '@libs/core/domain/contracts/message-broker.service.contracts';
import { MESSAGE_BROKER_SERVICE_TOKEN } from '@libs/core/domain/contracts/message-broker.service.contracts';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import {
    IntegrationStatusFilter,
    ITeamWithIntegrations,
} from '@libs/organization/domain/team/interfaces/team.interface';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@libs/automation/domain/automation/contracts/automation.service';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

const API_CRON_SYNC_CODE_REVIEW_REACTIONS =
    process.env.API_CRON_SYNC_CODE_REVIEW_REACTIONS;

// Max DB queries in flight. Applies only to the two fan-outs that are
// actually database work — teamAutomation/find and
// automationExecution/findByPeriod — where each team.map() entry is one
// query, so N teams meant N simultaneous connections and starved the
// pool during the 2026-08-06 incident. The API pool is 25
// (api.module.ts passes poolSize: 25, overriding the factory default),
// so 5 leaves 20 slots for request traffic.
//
// The third fan-out (publish to RabbitMQ) is deliberately left
// unthrottled: it issues no queries, so gating it on a DB budget would
// only make the cron slower.
const DB_CONCURRENCY = 5;

const LOCK_KEY = 'CRON:SYNC_CODE_REVIEW_REACTIONS';
// TTL just longer than the worst observed run so a crashed holder
// unlocks quickly for the next tick.
const LOCK_TTL_MS = 4 * 60 * 1000;

@Injectable()
export class CodeReviewFeedbackCronProvider {
    private readonly logger = createLogger(CodeReviewFeedbackCronProvider.name);
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
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(API_CRON_SYNC_CODE_REVIEW_REACTIONS, {
        name: 'Sync Code Review Reactions',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        // Every API pod fires this cron; without a lock, N pods run the
        // full teams.map() rajada N times in parallel and collectively
        // starve the pool. One winner runs, the rest no-op.
        const lock = await this.distributedLockService
            .acquire(LOCK_KEY, { ttl: LOCK_TTL_MS })
            .catch((error) => {
                this.logger.error({
                    message: 'Failed to acquire sync-reactions cron lock',
                    context: CodeReviewFeedbackCronProvider.name,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                });
                return null;
            });

        if (!lock) {
            return;
        }

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
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const now = new Date();

            // Cap parallel DB queries across the 3 team-fan-outs below.
            // Previous behavior spawned one query per team simultaneously
            // (~40+ in a burst); the API pool has ~50 slots, so a single
            // rajada could starve everything else. limit(5) leaves ~45
            // slots free for regular traffic; the cron finishes a few
            // seconds slower but never drives a pool-timeout cascade.
            const limit = pLimit(DB_CONCURRENCY);

            const teamAutomationsResults = await Promise.allSettled(
                teams.map((team) =>
                    limit(() =>
                        this.teamAutomationService
                            .find({
                                team: { uuid: team.uuid },
                                automation: { uuid: automationUuid },
                                status: true,
                            })
                            .then((automations) => ({
                                team,
                                teamAutomation: automations?.[0],
                            })),
                    ),
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
                    limit(() =>
                        this.automationExecutionService
                            .findByPeriodAndTeamAutomationId(
                                sevenDaysAgo,
                                now,
                                teamAutomation.uuid,
                                AutomationStatus.SUCCESS,
                            )
                            .then((executions) => ({
                                team,
                                executions,
                            })),
                    ),
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
                        'No teams with successful executions in the last 7 days',
                    context: CodeReviewFeedbackCronProvider.name,
                });
                return;
            }

            // NOT wrapped in `limit`: this fan-out only formats messages
            // and hands them to RabbitMQ via publishSyncCodeReviewReactionsTasks
            // — it never touches Postgres, so throttling it against the DB
            // pool budget would cost wall-clock and buy nothing.
            const publishResults = await Promise.allSettled(
                teamsToProcess.map(({ team, executions }) =>
                    (async () => {
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
                    })(),
                ),
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
        } finally {
            await lock.release().catch((error) => {
                this.logger.error({
                    message: 'Failed to release sync-reactions cron lock',
                    context: CodeReviewFeedbackCronProvider.name,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                });
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
            this.messageBroker.transformMessageToMessageBroker({
                eventName: 'cron.codeReviewFeedback.syncCodeReviewReactions',
                message: task,
            });

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
