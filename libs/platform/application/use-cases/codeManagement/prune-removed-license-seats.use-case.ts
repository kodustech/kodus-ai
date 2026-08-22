import { Inject, Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersAutoAssignConfig } from '@libs/organization/domain/organizationParameters/types/organizationParameters.types';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
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
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
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

        // No provider enumerates apps in its member listing, and the pull
        // request author fallback only reaches back 60 days. A bot missing
        // from the list is therefore never evidence that it left the
        // organization — revoking its seat would silently stop reviews on an
        // agent that simply had a quiet month. The same holds for any seat an
        // admin granted by git id precisely because the list could not show it.
        const protectedIds = await this.resolveProtectedIds(
            organizationAndTeamData,
            memberList.members,
        );

        const candidates = activeSeats
            .map((seat) => String(seat.git_id))
            .filter((gitId) => !memberIds.has(gitId))
            .filter((gitId) => !protectedIds.has(gitId))
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

    private async resolveProtectedIds(
        organizationAndTeamData: OrganizationAndTeamData,
        members: ReadonlyArray<{ id: string | number; type?: string }>,
    ): Promise<Set<string>> {
        const botIds = new Set(
            members
                .filter((member) => member.type === 'bot')
                .map((member) => String(member.id)),
        );

        // Bots discovered on earlier runs, recorded when they were seeded into
        // the ignore list. Covers the ones that have gone quiet and dropped out
        // of the member list entirely.
        try {
            const parameter =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                    organizationAndTeamData,
                );

            const config =
                parameter?.configValue as OrganizationParametersAutoAssignConfig;

            for (const gitId of [
                ...(config?.seededBotIds ?? []),
                ...(config?.manuallyAssignedIds ?? []),
            ]) {
                botIds.add(String(gitId));
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not read protected seat ids; a bot or manually assigned seat may be proposed for revocation',
                context: PruneRemovedLicenseSeatsUseCase.name,
                metadata: { ...organizationAndTeamData },
                error,
            });
        }

        return botIds;
    }
}
