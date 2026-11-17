import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { createLogger } from '@libs/core/log/logger';
import { SyncAllRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/sync-all-repositories.use-case';

const CRON_SYNC_ALL_REPOSITORIES =
    process.env.API_CRON_SYNC_ALL_REPOSITORIES || '*/10 * * * *';

/**
 * Picks up repositories created after a team turned on "review every
 * repository". Overlap is handled inside the sync: each credential runs under
 * its own distributed lock, so replicas firing together skip what another one
 * is already syncing.
 */
@Injectable()
export class SyncAllRepositoriesCronProvider {
    private readonly logger = createLogger(SyncAllRepositoriesCronProvider.name);

    constructor(
        private readonly syncAllRepositoriesUseCase: SyncAllRepositoriesUseCase,
    ) {}

    @Cron(CRON_SYNC_ALL_REPOSITORIES, {
        name: 'Sync All Repositories',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron(): Promise<void> {
        try {
            await this.syncAllRepositoriesUseCase.runScheduledSync();
        } catch (error) {
            this.logger.error({
                message: 'Scheduled repository sync failed',
                context: SyncAllRepositoriesCronProvider.name,
                error,
            });
        }
    }
}
