import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { createLogger } from '@libs/core/log/logger';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { IntegrationStatusFilter } from '@libs/organization/domain/team/interfaces/team.interface';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { RefreshCodeAreaRiskMapService } from '@libs/platformData/infrastructure/adapters/services/refresh-code-area-risk-map.service';

const MAX_REPOSITORIES_PER_RUN = 20;
const RUN_INTERVAL_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class RefreshCodeAreaRiskMapCron {
    private readonly logger = createLogger(RefreshCodeAreaRiskMapCron.name);

    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teams: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parameters: IParametersService,
        private readonly refresh: RefreshCodeAreaRiskMapService,
        private readonly locks: DistributedLockService,
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
            repositories.sort((a, b) =>
                `${a.organizationId}:${a.id}`.localeCompare(
                    `${b.organizationId}:${b.id}`,
                ),
            );
            const pages = Math.ceil(
                repositories.length / MAX_REPOSITORIES_PER_RUN,
            );
            if (!pages) return;
            const page = Math.floor(Date.now() / RUN_INTERVAL_MS) % pages;
            const selected = repositories.slice(
                page * MAX_REPOSITORIES_PER_RUN,
                (page + 1) * MAX_REPOSITORIES_PER_RUN,
            );
            for (const repo of selected) {
                try {
                    await this.refresh.refreshOneBatch({
                        organizationAndTeamData: {
                            organizationId: repo.organizationId,
                            teamId: repo.teamId,
                        },
                        repository: { id: repo.id, name: repo.name },
                    });
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
