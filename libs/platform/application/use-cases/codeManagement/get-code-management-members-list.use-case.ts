import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { CacheService } from '@libs/core/cache/cache.service';
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
    private static readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

    constructor(
        private readonly organizationMemberListService: OrganizationMemberListService,
        private readonly cacheService: CacheService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    public async execute(
        teamId?: string,
    ): Promise<OrganizationMemberListResult> {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId,
        };

        const cacheKey = this.buildCacheKey(
            organizationAndTeamData.organizationId,
            teamId,
        );

        try {
            const cached =
                await this.cacheService.getFromCache<
                    OrganizationMemberSummary[]
                >(cacheKey);

            if (cached?.length > 0) {
                return { status: 'ok', members: cached };
            }
        } catch {
            // Cache miss or error, proceed with fetch
        }

        const result = await this.organizationMemberListService.fetch(
            organizationAndTeamData,
        );

        if (result.status === 'ok') {
            await this.cacheService
                .addToCache(
                    cacheKey,
                    result.members,
                    GetCodeManagementMemberListUseCase.CACHE_TTL,
                )
                .catch(() => {});
        }

        return result;
    }

    public async refreshMembers(
        teamId?: string,
    ): Promise<OrganizationMemberListResult> {
        const cacheKey = this.buildCacheKey(
            this.request.user.organization.uuid,
            teamId,
        );

        await this.cacheService.removeFromCache(cacheKey);

        return this.execute(teamId);
    }

    private buildCacheKey(organizationId: string, teamId?: string): string {
        return teamId !== undefined
            ? `org_members_${organizationId}_${teamId}`
            : `org_members_${organizationId}`;
    }
}
