import { Inject, Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { OrganizationMemberListService } from '@libs/platform/application/services/organization-member-list.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

export type PruneRemovedLicenseSeatsResult = {
    status: 'ok' | 'members_unavailable';
    candidates: string[];
    revoked: string[];
    failed: string[];
};

export type PruneRemovedLicenseSeatsParams = {
    organizationAndTeamData: OrganizationAndTeamData;
    /** Report the seats that would be released without touching them. */
    dryRun?: boolean;
    /** Limit the revocation to these git ids; defaults to every stale seat. */
    gitIds?: string[];
};

@Injectable()
export class PruneRemovedLicenseSeatsUseCase {
    private readonly logger = createLogger(
        PruneRemovedLicenseSeatsUseCase.name,
    );

    constructor(
        private readonly organizationMemberListService: OrganizationMemberListService,
        private readonly codeManagementService: CodeManagementService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
    ) {}

    public async execute(
        params: PruneRemovedLicenseSeatsParams,
    ): Promise<PruneRemovedLicenseSeatsResult> {
        const { organizationAndTeamData, dryRun, gitIds } = params;

        const memberList = await this.organizationMemberListService.fetch(
            organizationAndTeamData,
        );

        // Revoking against an unconfirmed member list would strip every seat in
        // the organization on a provider outage.
        if (memberList.status !== 'ok') {
            this.logger.warn({
                message:
                    'Skipping license seat prune: organization members could not be confirmed',
                context: PruneRemovedLicenseSeatsUseCase.name,
                metadata: { ...organizationAndTeamData },
            });

            return {
                status: 'members_unavailable',
                candidates: [],
                revoked: [],
                failed: [],
            };
        }

        const memberIds = new Set(
            memberList.members.map((member) => String(member.id)),
        );

        const activeSeats = await this.licenseService.getAllUsersWithLicense(
            organizationAndTeamData,
        );

        const requested = gitIds?.length ? new Set(gitIds.map(String)) : null;

        const candidates = activeSeats
            .map((seat) => String(seat.git_id))
            .filter((gitId) => !memberIds.has(gitId))
            .filter((gitId) => !requested || requested.has(gitId));

        if (dryRun || candidates.length === 0) {
            return { status: 'ok', candidates, revoked: [], failed: [] };
        }

        const provider = await this.codeManagementService.getTypeIntegration(
            organizationAndTeamData,
        );

        // One batched call rather than one per seat: the seat store is read,
        // mutated and written back as a whole, so concurrent single-seat
        // revokes lose updates.
        const { revoked, failed } = await this.licenseService.unassignLicenses(
            organizationAndTeamData,
            candidates,
            provider,
        );

        this.logger.log({
            message: 'Pruned license seats for users removed from the git org',
            context: PruneRemovedLicenseSeatsUseCase.name,
            metadata: {
                ...organizationAndTeamData,
                revokedCount: revoked.length,
                failedCount: failed.length,
            },
        });

        return { status: 'ok', candidates, revoked, failed };
    }
}
