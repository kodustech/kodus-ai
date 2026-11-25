import { Inject, Injectable, Optional } from '@nestjs/common';

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
import { authorFiltersFor } from '@libs/organization/domain/organizationParameters/utils/author-filters';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationMemberListService } from '@libs/platform/application/services/organization-member-list.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { primaryConnectionOf } from '@libs/integrations/domain/integrations/utils/primary-connection';

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

/** One pool's result, plus what the shared-seat pass needs from it. */
type PoolPrune = PruneRemovedLicenseSeatsResult & {
    memberIds?: Set<string>;
    protectedIds?: Set<string>;
    sharedIds?: Set<string>;
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
        @Optional()
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService?: IIntegrationService,
    ) {}

    /**
     * Each Git connection of a workspace has its own seats, checked against
     * its own members. A workspace with one connection, or a call naming a
     * connection, takes the single path.
     */
    public async execute(
        params: PruneRemovedLicenseSeatsParams,
    ): Promise<PruneRemovedLicenseSeatsResult> {
        const { organizationAndTeamData } = params;
        const connections =
            organizationAndTeamData.integrationId || !this.integrationService
                ? []
                : ((await this.integrationService.find({
                      organization: {
                          uuid: organizationAndTeamData.organizationId,
                      },
                      team: { uuid: organizationAndTeamData.teamId },
                      integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                      status: true,
                  })) ?? []);

        if (connections.length <= 1) {
            const {
                memberIds: _memberIds,
                protectedIds: _protectedIds,
                sharedIds: _sharedIds,
                ...result
            } = await this.pruneSeatPool(params);
            return result;
        }

        // Billing keeps the workspace seats on one connection and, until it
        // knows which, answers every connection with them: pruning those
        // against one connection's members would strip the others' seats.
        const primary = primaryConnectionOf(connections);
        const bound = await this.licenseService.bindPrimaryConnection(
            {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            },
            primary.uuid,
        );
        if (!bound) {
            this.logger.error({
                message:
                    'Skipping license seat prune: billing could not confirm the workspace primary connection',
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

        const merged: PruneRemovedLicenseSeatsResult = {
            status: 'ok',
            candidates: [],
            revoked: [],
            failed: [],
        };
        const pools: PoolPrune[] = [];
        for (const connection of connections) {
            const result = await this.pruneSeatPool({
                ...params,
                organizationAndTeamData: {
                    ...organizationAndTeamData,
                    integrationId: connection.uuid,
                },
            });
            pools.push(result);
            if (result.status !== 'ok') merged.status = result.status;
            merged.candidates.push(...result.candidates);
            merged.revoked.push(...result.revoked);
            merged.failed.push(...result.failed);
        }

        if (merged.status === 'ok') {
            const shared = await this.pruneSharedSeats(
                params,
                connections[0].uuid,
                pools,
            );
            merged.candidates.push(...shared.candidates);
            merged.revoked.push(...shared.revoked);
            merged.failed.push(...shared.failed);
        }
        return merged;
    }

    /**
     * Seats every connection shares go once no connection lists their holder:
     * only after every connection's members were read.
     */
    private async pruneSharedSeats(
        params: PruneRemovedLicenseSeatsParams,
        integrationId: string,
        pools: PoolPrune[],
    ): Promise<Pick<PoolPrune, 'candidates' | 'revoked' | 'failed'>> {
        const union = (pick: (pool: PoolPrune) => Set<string> | undefined) =>
            new Set(pools.flatMap((pool) => [...(pick(pool) ?? [])]));
        const members = union((pool) => pool.memberIds);
        const protectedIds = union((pool) => pool.protectedIds);
        const requested = params.gitIds?.length
            ? new Set(params.gitIds.map(String))
            : null;
        const candidates = [...union((pool) => pool.sharedIds)].filter(
            (gitId) =>
                !members.has(gitId) &&
                !protectedIds.has(gitId) &&
                (!requested || requested.has(gitId)),
        );
        if (params.dryRun || !candidates.length) {
            return { candidates, revoked: [], failed: [] };
        }

        const organizationAndTeamData = {
            ...params.organizationAndTeamData,
            integrationId,
        };
        const provider = await this.codeManagementService.getTypeIntegration(
            organizationAndTeamData,
        );
        const { revoked, failed } = await this.licenseService.unassignLicenses(
            organizationAndTeamData,
            candidates,
            provider,
        );
        this.logger.log({
            message: 'Pruned license seats shared by every Git connection',
            context: PruneRemovedLicenseSeatsUseCase.name,
            metadata: {
                ...params.organizationAndTeamData,
                revokedCount: revoked.length,
                failedCount: failed.length,
            },
        });
        return { candidates, revoked, failed };
    }

    private async pruneSeatPool(
        params: PruneRemovedLicenseSeatsParams,
    ): Promise<PoolPrune> {
        const { organizationAndTeamData, dryRun, gitIds } = params;

        // Read once: the seats checked with the provider below must be the
        // seats revoked from, or a seat assigned (or read back empty) between
        // two reads would be revoked unchecked.
        const activeSeats = await this.licenseService.getAllUsersWithLicense(
            organizationAndTeamData,
        );
        const seatIds = (activeSeats ?? []).map((seat) => String(seat.git_id));
        // Seats every connection shares: one connection's members cannot
        // show their holder left, so a per-connection run leaves them.
        const sharedIds = new Set(
            organizationAndTeamData.integrationId
                ? (activeSeats ?? [])
                      .filter((seat) => seat.sharedAcrossConnections)
                      .map((seat) => String(seat.git_id))
                : [],
        );

        const memberList = await this.organizationMemberListService.fetch(
            organizationAndTeamData,
            { requireAuthors: true, skipCache: true, seatHolderIds: seatIds },
        );

        // Revoking against an unconfirmed member list would strip every seat in
        // the organization on a provider outage.
        if (memberList.status !== 'ok') {
            this.logger.error({
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

        const candidates = seatIds
            .filter((gitId) => !memberIds.has(gitId))
            .filter((gitId) => !protectedIds.has(gitId))
            .filter((gitId) => !sharedIds.has(gitId))
            .filter((gitId) => !requested || requested.has(gitId));

        if (sharedIds.size) {
            this.logger.log({
                message:
                    'Left seats shared by every Git connection to the shared pass',
                context: PruneRemovedLicenseSeatsUseCase.name,
                metadata: {
                    ...organizationAndTeamData,
                    sharedSeatCount: sharedIds.size,
                },
            });
        }

        const seen = { memberIds, protectedIds, sharedIds };
        if (dryRun || candidates.length === 0) {
            return {
                status: 'ok',
                candidates,
                revoked: [],
                failed: [],
                ...seen,
            };
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

        return { status: 'ok', candidates, revoked, failed, ...seen };
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
                ...authorFiltersFor(
                    config,
                    organizationAndTeamData.integrationId,
                ).seededBotIds,
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
