import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { CacheService } from '@libs/core/cache/cache.service';
import { createLogger } from '@libs/core/log/logger';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    OrganizationMemberListResult,
    OrganizationMemberListService,
    OrganizationMemberSummary,
} from '@libs/platform/application/services/organization-member-list.service';

@Injectable()
export class GetCodeManagementMemberListUseCase implements IUseCase {
    private readonly logger = createLogger(
        GetCodeManagementMemberListUseCase.name,
    );

    private static readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

    constructor(
        private readonly organizationMemberListService: OrganizationMemberListService,
        private readonly cacheService: CacheService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    public async execute(
        teamId?: string,
        options: { skipCache?: boolean } = {},
        connectionId?: string,
    ): Promise<OrganizationMemberListResult> {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId,
            ...(connectionId ? { integrationId: connectionId } : {}),
        };

        const cacheKey = this.buildCacheKey(
            organizationAndTeamData.organizationId,
            teamId,
            connectionId,
        );

        if (!options.skipCache) {
            try {
                const cached = await this.cacheService.getFromCache<{
                    members: OrganizationMemberSummary[];
                    absentSeatHolderIds?: string[];
                }>(cacheKey);

                if (cached?.members?.length > 0) {
                    return { status: 'ok', complete: true, ...cached };
                }
            } catch (error) {
                // Not fatal — the fetch below still serves the request — but a
                // silent swallow makes a failing cache backend invisible.
                this.logger.warn({
                    message:
                        'Could not read the cached member list; fetching from the code integration',
                    context: GetCodeManagementMemberListUseCase.name,
                    error,
                    metadata: { ...organizationAndTeamData },
                });
            }
        }

        const result = await this.organizationMemberListService.fetch(
            organizationAndTeamData,
            options,
        );

        // Only a complete list is cached: a partial one served for the full TTL
        // would keep showing members as missing after the provider recovers.
        if (result.status === 'ok' && result.complete) {
            await this.cacheService
                .addToCache(
                    cacheKey,
                    {
                        members: result.members,
                        absentSeatHolderIds: result.absentSeatHolderIds,
                    },
                    GetCodeManagementMemberListUseCase.CACHE_TTL,
                )
                .catch(() => {});
        }

        return result;
    }

    public async refreshMembers(
        teamId?: string,
        connectionId?: string,
    ): Promise<OrganizationMemberListResult> {
        const cacheKey = this.buildCacheKey(
            this.request.user.organization.uuid,
            teamId,
            connectionId,
        );

        await this.cacheService.removeFromCache(cacheKey);

        return this.execute(teamId, { skipCache: true }, connectionId);
    }

    private buildCacheKey(
        organizationId: string,
        teamId?: string,
        connectionId?: string,
    ): string {
        // v3: entries hold the confirmed-absent seat ids beside the members;
        // v1 entries may hold a partial list.
        const base =
            teamId !== undefined
                ? `org_members_v3_${organizationId}_${teamId}`
                : `org_members_v3_${organizationId}`;
        return connectionId ? `${base}_${connectionId}` : base;
    }
}
