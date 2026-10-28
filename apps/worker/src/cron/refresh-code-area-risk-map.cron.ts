import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import pLimit from 'p-limit';

import { createLogger } from '@libs/core/log/logger';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { runWithBoundedTimeout } from '@libs/core/workflow/infrastructure/run-with-bounded-timeout';
import {
    CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN,
    IConditionalApprovalAccessService,
} from '@libs/code-review/domain/approval/conditional-approval-access.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { IntegrationStatusFilter } from '@libs/organization/domain/team/interfaces/team.interface';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    IRefreshCodeAreaRiskMapService,
    REFRESH_CODE_AREA_RISK_MAP_SERVICE_TOKEN,
} from '@libs/platformData/domain/code-area-risk/code-area-risk-map.contract';

// Each batch reads up to ten PRs, so a repository's first scan takes several.
// The run spends this many batches, finishing scans before refreshing others.
const MAX_BATCHES_PER_RUN = 40;
const STATUS_READ_CONCURRENCY = 10;
const STATUS_READ_TIMEOUT_MS = 10_000;
const RUN_INTERVAL_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class RefreshCodeAreaRiskMapCron {
    private readonly logger = createLogger(RefreshCodeAreaRiskMapCron.name);

    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teams: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parameters: IParametersService,
        @Inject(REFRESH_CODE_AREA_RISK_MAP_SERVICE_TOKEN)
        private readonly refresh: IRefreshCodeAreaRiskMapService,
        private readonly locks: DistributedLockService,
        @Inject(CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN)
        private readonly access: IConditionalApprovalAccessService,
        private readonly codeManagement: CodeManagementService,
    ) {}

    @Cron('0 */2 * * *', {
        name: 'REFRESH CODE AREA RISK MAP',
        waitForCompletion: true,
    })
    async handleCron(): Promise<void> {
        const lock = await this.locks.acquire(
            'CRON:REFRESH_CODE_AREA_RISK_MAP',
            {
                ttl: RUN_INTERVAL_MS,
            },
        );
        if (!lock) return;

        try {
            const teams = await this.teams.findTeamsWithIntegrations({
                integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });
            const repositories: Array<{
                organizationId: string;
                teamId: string;
                id: string;
                name: string;
            }> = [];
            for (const team of teams ?? []) {
                const organizationId = team.organization?.uuid;
                if (!organizationId) continue;
                if (
                    !(await this.access.isEnabled({
                        organizationId,
                        teamId: team.uuid,
                    }))
                ) {
                    continue;
                }
                const source = await this.codeManagement.getTypeIntegration({
                    organizationId,
                    teamId: team.uuid,
                });
                if (
                    ![PlatformType.GITHUB, PlatformType.GITLAB].includes(source)
                ) {
                    continue;
                }
                const config = await this.parameters.findOne({
                    configKey: ParametersKey.CODE_REVIEW_CONFIG,
                    team: { uuid: team.uuid },
                    active: true,
                });
                for (const repo of config?.configValue?.repositories ?? []) {
                    if (!repo.id || !repo.name || repo.isSelected === false) {
                        continue;
                    }
                    repositories.push({
                        organizationId,
                        teamId: team.uuid,
                        id: repo.id,
                        name: repo.name,
                    });
                }
            }
            if (!repositories.length) return;

            // Never scanned first, then unfinished scans, then complete ones
            // stalest first: a fixed rotation left first scans incomplete for
            // weeks while finished repositories were refreshed. A status that
            // could not be read goes last instead of passing as never scanned.
            const limit = pLimit(STATUS_READ_CONCURRENCY);
            const statuses = await Promise.all(
                repositories.map((repo) =>
                    limit(async () => {
                        try {
                            return {
                                status: await runWithBoundedTimeout(
                                    this.refresh.readStatus(
                                        repo.organizationId,
                                        repo.id,
                                    ),
                                    STATUS_READ_TIMEOUT_MS,
                                    'code-area history status read',
                                ),
                                unreadable: false,
                            };
                        } catch (error) {
                            this.logger.warn({
                                message:
                                    'Could not read code-area history status',
                                context: RefreshCodeAreaRiskMapCron.name,
                                metadata: {
                                    organizationId: repo.organizationId,
                                    repositoryId: repo.id,
                                    timeoutMs: STATUS_READ_TIMEOUT_MS,
                                },
                                error,
                            });
                            return { status: null, unreadable: true };
                        }
                    }),
                ),
            );
            const rank = ({ status, unreadable }: (typeof statuses)[number]) =>
                unreadable ? 3 : !status ? 0 : status.complete ? 2 : 1;
            // A complete scan's window ends where its last refresh began.
            const age = ({ status }: (typeof statuses)[number]) =>
                (status?.complete ? status.windowEnd : status?.cursorEnd) ?? '';
            const ordered = repositories
                .map((repo, index) => ({ repo, read: statuses[index] }))
                .sort(
                    (a, b) =>
                        rank(a.read) - rank(b.read) ||
                        age(a.read).localeCompare(age(b.read)) ||
                        `${a.repo.organizationId}:${a.repo.id}`.localeCompare(
                            `${b.repo.organizationId}:${b.repo.id}`,
                        ),
                );

            let batches = 0;
            for (const { repo } of ordered) {
                if (batches >= MAX_BATCHES_PER_RUN) break;
                try {
                    // An unfinished scan keeps going: a batch always moves the
                    // cursor, even through an empty week or unmerged PRs. It
                    // stops when PRs could not be read, so an unreadable
                    // repository does not spend the run's budget.
                    let result: { complete: boolean; failed: boolean };
                    do {
                        result = await this.refresh.refreshOneBatch({
                            organizationAndTeamData: {
                                organizationId: repo.organizationId,
                                teamId: repo.teamId,
                            },
                            repository: { id: repo.id, name: repo.name },
                        });
                        batches++;
                    } while (
                        result?.complete === false &&
                        result.failed === false &&
                        batches < MAX_BATCHES_PER_RUN
                    );
                } catch (error) {
                    this.logger.warn({
                        message: 'Could not refresh code-area history batch',
                        context: RefreshCodeAreaRiskMapCron.name,
                        metadata: {
                            organizationId: repo.organizationId,
                            repositoryId: repo.id,
                        },
                        error,
                    });
                }
            }
        } finally {
            await lock.release();
        }
    }
}
