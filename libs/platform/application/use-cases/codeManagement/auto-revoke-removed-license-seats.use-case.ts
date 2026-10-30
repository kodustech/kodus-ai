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

    /**
     * Writes back only the revocation timers, merged onto a freshly read
     * config. The snapshot taken at the top of `execute` is stale by the time
     * we get here — the git provider and billing calls in between take seconds
     * — so writing it back wholesale would revert any seat setting an admin
     * saved during the sweep. Re-reading narrows that window to the gap between
     * this read and the write; closing it completely needs a conditional
     * update, which the parameters service does not expose today.
     */
    private async persistPendingRevocations(
        organizationAndTeamData: OrganizationAndTeamData,
        previous: Record<string, string>,
        next: Record<string, string>,
    ): Promise<void> {
        if (JSON.stringify(previous) === JSON.stringify(next)) {
            return;
        }

        const current = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            organizationAndTeamData,
        );

        // execute() already proved the config existed, so an empty re-read means
        // it was deleted during the sweep. Writing here would resurrect it from
        // defaults and silently drop allowedUsers/revokeGraceDays. Dropping the
        // timers instead is harmless: with no config the next sweep is a no-op.
        if (!current?.configValue) {
            this.logger.warn({
                message:
                    'Auto license assignment config disappeared mid-sweep; not persisting revocation timers',
                context: AutoRevokeRemovedLicenseSeatsUseCase.name,
                metadata: { ...organizationAndTeamData },
            });
            return;
        }

        await this.organizationParametersService.createOrUpdateConfig(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            { ...current.configValue, pendingRevocations: next },
            organizationAndTeamData,
        );
    }
}
