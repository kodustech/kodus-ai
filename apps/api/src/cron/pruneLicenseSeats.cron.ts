import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { createLogger } from '@libs/core/log/logger';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { IntegrationStatusFilter } from '@libs/organization/domain/team/interfaces/team.interface';
import { AutoRevokeRemovedLicenseSeatsUseCase } from '@libs/platform/application/use-cases/codeManagement/auto-revoke-removed-license-seats.use-case';

const CRON_PRUNE_LICENSE_SEATS =
    process.env.API_CRON_PRUNE_LICENSE_SEATS || '0 4 * * *';

const LOCK_KEY = 'CRON:PRUNE_LICENSE_SEATS';
const LOCK_TTL_MS = 1000 * 60 * 30;

@Injectable()
export class PruneLicenseSeatsCronProvider {
    private readonly logger = createLogger(PruneLicenseSeatsCronProvider.name);

    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        private readonly autoRevokeRemovedLicenseSeatsUseCase: AutoRevokeRemovedLicenseSeatsUseCase,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(CRON_PRUNE_LICENSE_SEATS, {
        name: 'Prune License Seats',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron(): Promise<void> {
        const lock = await this.acquireCronLock();

        if (!lock) {
            return;
        }

        try {
            const teams = await this.teamService.findTeamsWithIntegrations({
                integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });

            if (!teams?.length) {
                return;
            }

            let revokedTotal = 0;

            for (const team of teams) {
                const organizationAndTeamData = {
                    organizationId: team.organization?.uuid,
                    teamId: team.uuid,
                };

                if (!organizationAndTeamData.organizationId) {
                    continue;
                }

                try {
                    const result =
                        await this.autoRevokeRemovedLicenseSeatsUseCase.execute(
                            { organizationAndTeamData },
                        );

                    revokedTotal += result.revoked.length;
                } catch (error) {
                    this.logger.error({
                        message: 'Failed to auto-revoke license seats for team',
                        context: PruneLicenseSeatsCronProvider.name,
                        metadata: { ...organizationAndTeamData },
                        error,
                    });
                }
            }

            if (revokedTotal > 0) {
                this.logger.log({
                    message: 'License seat prune sweep finished',
                    context: PruneLicenseSeatsCronProvider.name,
                    metadata: { revokedTotal, teamCount: teams.length },
                });
            }
        } finally {
            await lock.release().catch(() => {});
        }
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            const lock = await this.distributedLockService.acquire(LOCK_KEY, {
                ttl: LOCK_TTL_MS,
            });

            if (!lock) {
                this.logger.log({
                    message: 'Cron execution skipped - Lock already acquired',
                    context: PruneLicenseSeatsCronProvider.name,
                    metadata: { lockKey: LOCK_KEY },
                });
                return null;
            }

            return lock;
        } catch (error) {
            this.logger.error({
                message: 'Error acquiring distributed lock for cron execution',
                context: PruneLicenseSeatsCronProvider.name,
                metadata: { lockKey: LOCK_KEY },
                error,
            });
            return null;
        }
    }
}
