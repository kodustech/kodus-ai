import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    RepositorySelectionConfig,
    RepositorySelectionMode,
    RepositorySyncState,
} from '@libs/platform/application/services/repository-sync/repository-sync.types';

import { SyncAllRepositoriesUseCase } from './sync-all-repositories.use-case';

const MODES: RepositorySelectionMode[] = ['manual', 'all'];

export type RepositorySyncStatusView = Omit<
    RepositorySyncState,
    | 'pendingAstRepositoryIds'
    | 'pendingBackfillRepositoryIds'
    | 'pendingAstAttempts'
> & { pendingAstBuilds: number; pendingBackfills: number };

export interface RepositorySelectionView {
    mode: RepositorySelectionMode;
    includeForksAndMirrors: boolean;
    sync: RepositorySyncStatusView | null;
}

@Injectable()
export class GetRepositorySelectionUseCase {
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<RepositorySelectionView> {
        const { organizationAndTeamData } = params;

        const [selection, state] = await Promise.all([
            this.integrationConfigService.findIntegrationConfigFormatted<RepositorySelectionConfig>(
                IntegrationConfigKey.REPOSITORY_SELECTION,
                organizationAndTeamData,
            ),
            this.integrationConfigService.findIntegrationConfigFormatted<RepositorySyncState>(
                IntegrationConfigKey.REPOSITORY_SYNC_STATE,
                organizationAndTeamData,
            ),
        ]);

        let sync: RepositorySyncStatusView | null = null;
        if (state) {
            const {
                pendingAstRepositoryIds = [],
                pendingBackfillRepositoryIds = [],
                pendingAstAttempts: _attempts,
                ...rest
            } = state;
            sync = {
                ...rest,
                pendingAstBuilds: pendingAstRepositoryIds.length,
                pendingBackfills: pendingBackfillRepositoryIds.length,
            };
        }

        return {
            mode: selection?.mode === 'all' ? 'all' : 'manual',
            includeForksAndMirrors: Boolean(selection?.includeForksAndMirrors),
            sync,
        };
    }
}

/**
 * Switches a team between picking repositories by hand and reviewing every
 * repository its credential can see. Enabling starts the first sync in the
 * background; going back to manual keeps the current list as the manual
 * selection.
 */
@Injectable()
export class SetRepositorySelectionUseCase {
    private readonly logger = createLogger(SetRepositorySelectionUseCase.name);

    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        private readonly syncAllRepositoriesUseCase: SyncAllRepositoriesUseCase,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        mode: RepositorySelectionMode;
        includeForksAndMirrors?: boolean;
        actorUserId?: string;
    }): Promise<RepositorySelectionConfig> {
        const { organizationAndTeamData, mode, actorUserId } = params;

        if (!MODES.includes(mode)) {
            throw new BadRequestException(
                `Unknown repository selection mode: ${String(mode)}`,
            );
        }

        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
        });

        if (!integration?.uuid) {
            throw new BadRequestException(
                'Connect a git integration before choosing which repositories to review.',
            );
        }

        const selection: RepositorySelectionConfig = {
            mode,
            includeForksAndMirrors: Boolean(params.includeForksAndMirrors),
            updatedAt: new Date().toISOString(),
            updatedBy: actorUserId,
        };

        await this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.REPOSITORY_SELECTION,
            selection,
            integration.uuid,
            organizationAndTeamData,
        );

        this.logger.log({
            message: 'Repository selection mode changed',
            context: SetRepositorySelectionUseCase.name,
            metadata: {
                ...organizationAndTeamData,
                mode,
                includeForksAndMirrors: selection.includeForksAndMirrors,
                actorUserId,
            },
        });

        if (mode === 'all') {
            void this.syncAllRepositoriesUseCase
                .syncTeam(organizationAndTeamData, 'enable')
                .catch((error) => {
                    this.logger.error({
                        message: 'The first repository sync failed',
                        context: SetRepositorySelectionUseCase.name,
                        error,
                        metadata: organizationAndTeamData,
                    });
                });
        }

        return selection;
    }
}

@Injectable()
export class PreviewAllRepositoriesUseCase {
    constructor(
        private readonly syncAllRepositoriesUseCase: SyncAllRepositoriesUseCase,
    ) {}

    execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        includeForksAndMirrors?: boolean;
    }) {
        return this.syncAllRepositoriesUseCase.preview(
            params.organizationAndTeamData,
            { includeForksAndMirrors: params.includeForksAndMirrors },
        );
    }
}
