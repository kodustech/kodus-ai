import { Inject, Injectable } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersAutoAssignConfig } from '@libs/organization/domain/organizationParameters/types/organizationParameters.types';

import { PruneRemovedLicenseSeatsUseCase } from './prune-removed-license-seats.use-case';

const DEFAULT_GRACE_DAYS = 7;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

export type AutoRevokeRemovedLicenseSeatsResult = {
    status: 'disabled' | 'members_unavailable' | 'ok';
    pending: string[];
    revoked: string[];
    failed: string[];
};

@Injectable()
export class AutoRevokeRemovedLicenseSeatsUseCase {
    private readonly logger = createLogger(
        AutoRevokeRemovedLicenseSeatsUseCase.name,
    );

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly pruneRemovedLicenseSeatsUseCase: PruneRemovedLicenseSeatsUseCase,
    ) {}

    public async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<AutoRevokeRemovedLicenseSeatsResult> {
        const { organizationAndTeamData } = params;

        const parameter = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            organizationAndTeamData,
        );

        const config: OrganizationParametersAutoAssignConfig | undefined =
            parameter?.configValue;

        if (!config?.autoRevokeRemovedUsers) {
            return {
                status: 'disabled',
                pending: [],
                revoked: [],
                failed: [],
            };
        }

        const preview = await this.pruneRemovedLicenseSeatsUseCase.execute({
            organizationAndTeamData,
            dryRun: true,
        });

        // A failed member lookup must not age out the pending timers, otherwise a
        // long provider outage would silently mature every seat into a revoke.
        if (preview.status !== 'ok') {
            return {
                status: 'members_unavailable',
                pending: [],
                revoked: [],
                failed: [],
            };
        }

        const now = Date.now();
        const graceMs =
            (config.revokeGraceDays ?? DEFAULT_GRACE_DAYS) * DAY_IN_MS;
        const previous = config.pendingRevocations ?? {};

        const pendingRevocations: Record<string, string> = {};
        const due: string[] = [];

        for (const gitId of preview.candidates) {
            const firstSeen = Date.parse(previous[gitId] ?? '');
            const missingSince = Number.isNaN(firstSeen) ? now : firstSeen;

            pendingRevocations[gitId] = new Date(missingSince).toISOString();

            if (now - missingSince >= graceMs) {
                due.push(gitId);
            }
        }

        let revoked: string[] = [];
        let failed: string[] = [];

        if (due.length > 0) {
            const result = await this.pruneRemovedLicenseSeatsUseCase.execute({
                organizationAndTeamData,
                gitIds: due,
            });

            revoked = result.revoked;
            failed = result.failed;

            // Failed revokes stay pending so the next run retries them.
            for (const gitId of revoked) {
                delete pendingRevocations[gitId];
            }

            this.logger.log({
                message: 'Auto-revoked license seats for users removed from git',
                context: AutoRevokeRemovedLicenseSeatsUseCase.name,
                metadata: {
                    ...organizationAndTeamData,
                    revokedCount: revoked.length,
                    failedCount: failed.length,
                },
            });
        }

        await this.persistPendingRevocations(
            organizationAndTeamData,
            config,
            previous,
            pendingRevocations,
        );

        return {
            status: 'ok',
            pending: Object.keys(pendingRevocations),
            revoked,
            failed,
        };
    }

    private async persistPendingRevocations(
        organizationAndTeamData: OrganizationAndTeamData,
        config: OrganizationParametersAutoAssignConfig,
        previous: Record<string, string>,
        next: Record<string, string>,
    ): Promise<void> {
        if (JSON.stringify(previous) === JSON.stringify(next)) {
            return;
        }

        await this.organizationParametersService.createOrUpdateConfig(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            { ...config, pendingRevocations: next },
            organizationAndTeamData,
        );
    }
}
