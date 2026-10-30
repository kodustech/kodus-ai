import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { resolveDashboardRepositoryScope } from './utils/team-repository-scope.util';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { CacheService } from '@libs/core/cache/cache.service';

// The distinct-authors aggregation groups every PR in scope, so it can't be run
// per keystroke. Cache the full list per team/repo-scope and filter in memory.
const AUTHORS_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTHORS_DEFAULT_LIMIT = 20;
const AUTHORS_FULL_LIST_CAP = 500;

export interface PullRequestAuthorSuggestion {
    id: string;
    name: string;
    username: string;
    count: number;
}

// Backs the Author-search autocomplete: distinct PR authors (by display name)
// for the selected team, ordered by how many PRs they've authored. Same
// team/repo scoping as the facets so the suggestions only include authors whose
// PRs are actually filterable on this screen.
@Injectable()
export class GetPullRequestAuthorsUseCase implements IUseCase {
    private readonly logger = createLogger(GetPullRequestAuthorsUseCase.name);

    constructor(
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly authorizationService: AuthorizationService,
        private readonly cacheService: CacheService,
    ) {}

    async execute(query: {
        teamId?: string;
        search?: string;
        limit?: number;
    }): Promise<PullRequestAuthorSuggestion[]> {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            return [];
        }

        try {
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: query.teamId,
            };

            // Same team/repo scope resolution as every other dashboard segment.
            const scope = await resolveDashboardRepositoryScope({
                authorizationService: this.authorizationService,
                integrationConfigService: this.integrationConfigService,
                user: this.request.user,
                organizationAndTeamData,
                onError: (error) =>
                    this.logger.warn({
                        message:
                            'Failed to resolve repository scope for authors',
                        context: GetPullRequestAuthorsUseCase.name,
                        error: error as Error,
                        metadata: { organizationId, teamId: query.teamId },
                    }),
            });
            if (!scope) {
                return [];
            }
            const { repositoryIds } = scope;

            // Cache the FULL author list per team/repo-scope (repo IDs in the key
            // so a narrower RBAC scope can't read a broader cache), then filter
            // in memory. The frontend loads once and filters client-side, so
            // this aggregation runs at most once per TTL instead of per
            // keystroke.
            const scopeKey = repositoryIds
                ? [...repositoryIds].sort().join(',')
                : 'all';
            const cacheKey = `pr-authors:${organizationId}:${query.teamId ?? 'noteam'}:${scopeKey}`;

            let authors =
                await this.cacheService.getFromCache<
                    PullRequestAuthorSuggestion[]
                >(cacheKey);
            if (!authors) {
                authors =
                    await this.pullRequestsService.findDistinctAuthorsByRepositoryIds(
                        organizationId,
                        repositoryIds,
                        undefined,
                        AUTHORS_FULL_LIST_CAP,
                    );
                await this.cacheService.addToCache(
                    cacheKey,
                    authors,
                    AUTHORS_CACHE_TTL_MS,
                );
            }

            const search = query.search?.trim().toLowerCase();
            const filtered = search
                ? authors.filter(
                      (a) =>
                          a.name.toLowerCase().includes(search) ||
                          a.username.toLowerCase().includes(search),
                  )
                : authors;

            const limit =
                query.limit && query.limit > 0
                    ? query.limit
                    : AUTHORS_DEFAULT_LIMIT;
            return filtered.slice(0, limit);
        } catch (error) {
            this.logger.error({
                message: 'Error listing pull request authors',
                context: GetPullRequestAuthorsUseCase.name,
                error,
                metadata: { organizationId },
            });
            return [];
        }
    }
}
