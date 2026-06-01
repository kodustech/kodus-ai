import { createLogger } from '@kodus/flow';
import { BadRequestException, Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesSyncService } from '../../infrastructure/adapters/services/kodyRulesSync.service';

/**
 * What the management endpoint can do to the IDE-synced rules of a given
 * repository, independent of the auto-sync toggle. Surfaced as a single
 * `POST /kody-rules/imported/manage` so the UI banner ("Auto-sync OFF, X
 * rules still active") can offer pause/resume/delete in one place.
 */
export type ManageImportedRulesAction = 'pause' | 'resume' | 'delete';

@Injectable()
export class ManageImportedKodyRulesUseCase {
    private readonly logger = createLogger(
        ManageImportedKodyRulesUseCase.name,
    );

    constructor(private readonly syncService: KodyRulesSyncService) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        action: ManageImportedRulesAction;
    }): Promise<{
        action: ManageImportedRulesAction;
        counts: {
            active: number;
            paused: number;
            deleted: number;
            pinned: number;
        };
    }> {
        const { organizationAndTeamData, repositoryId, action } = params;

        if (!repositoryId) {
            throw new BadRequestException('repositoryId is required');
        }
        if (!['pause', 'resume', 'delete'].includes(action)) {
            throw new BadRequestException(
                `action must be one of pause | resume | delete (got "${action}")`,
            );
        }

        switch (action) {
            case 'pause':
                await this.syncService.pauseAllIdeSyncRulesForRepository({
                    organizationAndTeamData,
                    repositoryId,
                });
                break;
            case 'resume':
                await this.syncService.resumeAllIdeSyncRulesForRepository({
                    organizationAndTeamData,
                    repositoryId,
                });
                break;
            case 'delete':
                await this.syncService.purgeAllIdeSyncRulesForRepository({
                    organizationAndTeamData,
                    repositoryId,
                });
                break;
        }

        const counts =
            await this.syncService.countIdeSyncRulesForRepository({
                organizationAndTeamData,
                repositoryId,
            });

        return { action, counts };
    }

    async count(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }) {
        return this.syncService.countIdeSyncRulesForRepository(params);
    }
}
