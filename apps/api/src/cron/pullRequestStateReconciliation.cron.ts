import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { createLogger } from '@libs/core/log/logger';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { IntegrationStatusFilter } from '@libs/organization/domain/team/interfaces/team.interface';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IPullRequestTerminalState } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import pLimit from 'p-limit';

const API_CRON_PULL_REQUEST_STATE_RECONCILIATION =
    process.env.API_CRON_PULL_REQUEST_STATE_RECONCILIATION || '17 */30 * * * *';

const REPOSITORY_BATCH_SIZE = 100;
const PROVIDER_CONCURRENCY = 8;

export function terminalStateFromProvider(
    pullRequest: any,
): IPullRequestTerminalState | null {
    if (!pullRequest) {
        return null;
    }

    const state = String(
        pullRequest.state ?? pullRequest.status ?? '',
    ).toLowerCase();
    const merged =
        pullRequest.merged === true ||
        Boolean(pullRequest.merged_at ?? pullRequest.mergedAt) ||
        state === PullRequestState.MERGED;
    const closed = [
        PullRequestState.CLOSED,
        'close',
        'declined',
        'completed',
        'abandoned',
    ].includes(state);

    if (!merged && !closed) {
        return null;
    }

    return {
        status: PullRequestState.CLOSED,
        merged,
        closedAt:
            pullRequest.merged_at ??
            pullRequest.mergedAt ??
            pullRequest.closed_at ??
            pullRequest.closedAt ??
            pullRequest.closedDate ??
            pullRequest.updated_at ??
            pullRequest.updatedAt ??
            pullRequest.updated_on ??
            '',
    };
}

/**
 * Webhooks remain the fast path; this cron is the source-of-truth safety net.
 * It asks the configured git provider about locally-open PRs and only applies
 * terminal transitions. It never rewrites files, suggestions, or review data.
 */
@Injectable()
export class PullRequestStateReconciliationCronProvider {
    private readonly logger = createLogger(
        PullRequestStateReconciliationCronProvider.name,
    );

    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,
        private readonly codeManagementService: CodeManagementService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(API_CRON_PULL_REQUEST_STATE_RECONCILIATION, {
        name: 'PULL REQUEST STATE RECONCILIATION',
        timeZone: 'America/Sao_Paulo',
        waitForCompletion: true,
    })
    async handleCron(): Promise<void> {
        const lock = await this.acquireCronLock();

        if (!lock) {
            return;
        }

        const totals = {
            checked: 0,
            corrected: 0,
            providerErrors: 0,
        };

        try {
            const teams = await this.teamService.findTeamsWithIntegrations({
                integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });

            const providerLimit = pLimit(PROVIDER_CONCURRENCY);

            for (const team of teams ?? []) {
                const organizationId = team.organization?.uuid;
                const teamId = team.uuid;

                if (!organizationId || !teamId) {
                    continue;
                }

                const parameter = await this.parametersService.findOne({
                    configKey: ParametersKey.CODE_REVIEW_CONFIG,
                    team: { uuid: teamId },
                    active: true,
                });
                const repositories = parameter?.configValue?.repositories;

                if (!Array.isArray(repositories)) {
                    continue;
                }

                const organizationAndTeamData: OrganizationAndTeamData = {
                    organizationId,
                    teamId,
                };

                for (const repository of repositories) {
                    if (!repository?.id || !repository?.name) {
                        continue;
                    }

                    const candidates =
                        await this.pullRequestService.findOpenForStateReconciliation(
                            organizationId,
                            String(repository.id),
                            REPOSITORY_BATCH_SIZE,
                        );

                    await Promise.all(
                        candidates.map((candidate) =>
                            providerLimit(async () => {
                                totals.checked += 1;

                                try {
                                    const remotePullRequest =
                                        await this.codeManagementService.getPullRequest(
                                            {
                                                organizationAndTeamData,
                                                repository: {
                                                    id: candidate.repository.id,
                                                    name: candidate.repository
                                                        .name,
                                                },
                                                prNumber: candidate.number,
                                            },
                                            candidate.provider as PlatformType,
                                        );
                                    const terminalState =
                                        terminalStateFromProvider(
                                            remotePullRequest,
                                        );

                                    if (!terminalState) {
                                        return;
                                    }

                                    const corrected =
                                        await this.pullRequestService.markTerminalIfOpen(
                                            candidate.uuid,
                                            organizationId,
                                            terminalState,
                                        );

                                    if (corrected) {
                                        totals.corrected += 1;
                                    }
                                } catch (error) {
                                    totals.providerErrors += 1;
                                    this.logger.error({
                                        message: `Failed to reconcile PR#${candidate.number}`,
                                        context:
                                            PullRequestStateReconciliationCronProvider.name,
                                        error:
                                            error instanceof Error
                                                ? error
                                                : undefined,
                                        metadata: {
                                            organizationId,
                                            teamId,
                                            repositoryId:
                                                candidate.repository.id,
                                            pullRequestNumber: candidate.number,
                                        },
                                    });
                                }
                            }),
                        ),
                    );
                }
            }

            this.logger.log({
                message: 'Pull request state reconciliation completed',
                context: PullRequestStateReconciliationCronProvider.name,
                metadata: totals,
            });
        } catch (error) {
            this.logger.error({
                message: 'Pull request state reconciliation run failed',
                context: PullRequestStateReconciliationCronProvider.name,
                error: error instanceof Error ? error : undefined,
                metadata: totals,
            });
        } finally {
            await this.releaseCronLock(lock);
        }
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:PULL_REQUEST_STATE_RECONCILIATION',
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire pull request reconciliation lock',
                context: PullRequestStateReconciliationCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });

            return null;
        }
    }

    private async releaseCronLock(lock: DistributedLock | null): Promise<void> {
        if (!lock) {
            return;
        }

        try {
            await lock.release();
        } catch (error) {
            this.logger.error({
                message: 'Failed to release pull request reconciliation lock',
                context: PullRequestStateReconciliationCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
