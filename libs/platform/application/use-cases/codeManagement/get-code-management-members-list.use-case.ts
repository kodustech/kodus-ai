import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { CacheService } from '@libs/core/cache/cache.service';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PullRequestHandlerService } from '@libs/code-review/infrastructure/adapters/services/pullRequestManager.service';

@Injectable()
export class GetCodeManagementMemberListUseCase implements IUseCase {
    private readonly logger = createLogger(
        GetCodeManagementMemberListUseCase.name,
    );
    private static readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestHandlerService: PullRequestHandlerService,
        private readonly cacheService: CacheService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(
        teamId?: string,
    ): Promise<{ name: string; id: string | number }[]> {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId,
        };

        const cacheKey =
            teamId !== undefined
                ? `org_members_${organizationAndTeamData.organizationId}_${teamId}`
                : `org_members_${organizationAndTeamData.organizationId}`;

        try {
            const cached =
                await this.cacheService.getFromCache<
                    { name: string; id: string | number }[]
                >(cacheKey);

            if (cached?.length > 0) {
                return cached;
            }
        } catch {
            // Cache miss or error, proceed with fetch
        }

        const [platformMembers, prMembers] = await Promise.all([
            this.fetchMembersFromCodeIntegration(organizationAndTeamData),
            this.fetchMembersFromPullRequests(organizationAndTeamData),
        ]);
        const mergedMembers = this.normalizeMembers([
            ...platformMembers,
            ...prMembers,
        ]);

        if (mergedMembers.length > 0) {
            await this.cacheService
                .addToCache(
                    cacheKey,
                    mergedMembers,
                    GetCodeManagementMemberListUseCase.CACHE_TTL,
                )
                .catch(() => {});
        }

        return mergedMembers;
    }

    public async refreshMembers(
        teamId?: string,
    ): Promise<{ name: string; id: string | number }[]> {
        const organizationId = this.request.user.organization.uuid;
        const cacheKey =
            teamId !== undefined
                ? `org_members_${organizationId}_${teamId}`
                : `org_members_${organizationId}`;

        await this.cacheService.removeFromCache(cacheKey);

        return this.execute(teamId);
    }

    private async fetchMembersFromCodeIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ name: string; id: string | number }[]> {
        try {
            const members = await this.codeManagementService.getListMembers({
                organizationAndTeamData,
            });

            return this.normalizeMembers(members);
        } catch (error) {
            this.logger.warn({
                message: 'Unable to fetch members from code integration',
                context: GetCodeManagementMemberListUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                },
                error,
            });

            return [];
        }
    }

    private async fetchMembersFromPullRequests(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ name: string; id: string | number; type?: string }[]> {
        try {
            const authors =
                await this.pullRequestHandlerService.getPullRequestAuthorsWithCache(
                    organizationAndTeamData,
                );

            const normalizedAuthors = (authors ?? []).map((author) => ({
                id: author?.id,
                name: author?.name,
            }));

            return this.normalizeMembers(normalizedAuthors);
        } catch (error) {
            this.logger.error({
                message: 'Unable to fetch members from pull requests fallback',
                context: GetCodeManagementMemberListUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                },
                error,
            });

            return [];
        }
    }

    private normalizeMembers(
        members: Array<{ name?: string; id?: string | number }> = [],
    ): { name: string; id: string | number }[] {
        if (!Array.isArray(members) || members.length === 0) {
            return [];
        }

        const uniqueMembers = new Map<
            string,
            { name: string; id: string | number }
        >();

        for (const member of members) {
            const normalized = this.normalizeMember(member);

            if (normalized && !uniqueMembers.has(String(normalized.id))) {
                uniqueMembers.set(String(normalized.id), normalized);
            }
        }

        return Array.from(uniqueMembers.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
    }

    private normalizeMember(member: {
        name?: string;
        id?: string | number;
        [key: string]: any;
    }): { name: string; id: string | number } | null {
        if (!member) {
            return null;
        }

        const rawId =
            member?.descriptor ??
            member?.id ??
            member?.uuid ??
            member?.originId ??
            member?.email ??
            member?.login ??
            member?.principalName;

        const rawName =
            member?.name ??
            member?.displayName ??
            member?.login ??
            member?.principalName ??
            member?.email;

        if (!rawId || !rawName) {
            return null;
        }

        return {
            id: rawId,
            name: rawName,
        };
    }
}
