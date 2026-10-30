import { Inject, Injectable } from '@nestjs/common';

import {
    TOKEN_USAGE_SERVICE_TOKEN,
    ITokenUsageService,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import {
    TokenUsageQueryContract,
    UsageByPrResultContract,
    DailyUsageByPrResultContract,
    DailyUsageByDeveloperResultContract,
    UsageByDeveloperResultContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IPullRequestUserMapping } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { CacheService } from '@libs/core/cache/cache.service';

// Same immutability logic as the overview cache: a window that ends before
// today never changes → cache long; a window that includes today still grows.
// Both windows cached 4h (see build-usage-summary.use-case for the rationale).
const DEV_TTL_PAST_MS = 4 * 60 * 60 * 1000;
const DEV_TTL_CURRENT_MS = 4 * 60 * 60 * 1000;

/** Epoch ms for 00:00 UTC today — the cutoff for "immutable past window". */
function startOfTodayUtc(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

@Injectable()
export class TokensByDeveloperUseCase {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        private readonly cacheService: CacheService,
    ) {}

    execute(
        query: TokenUsageQueryContract,
        daily: false,
    ): Promise<UsageByDeveloperResultContract[]>;

    execute(
        query: TokenUsageQueryContract,
        daily: true,
    ): Promise<DailyUsageByDeveloperResultContract[]>;

    async execute(
        query: TokenUsageQueryContract,
        daily: boolean,
    ): Promise<
        DailyUsageByDeveloperResultContract[] | UsageByDeveloperResultContract[]
    > {
        // Cache the whole by-developer result: unlike the cards (served by the
        // cached overview), this view re-runs the covered getUsageByPr scan on
        // EVERY load — so without this it costs ~4s each time. Key + TTL mirror
        // the overview cache (past window immutable → 6h, current → 2min).
        const cacheKey = [
            'usage:by-dev:v1',
            daily ? 'daily' : 'agg',
            query.organizationId,
            query.byok ? 'byok' : 'sys',
            query.start.getTime(),
            query.end.getTime(),
            query.timezone || 'UTC',
            query.models || '',
            query.prNumber ?? '',
            query.repositoryId ?? '',
            query.developer || '',
        ].join('|');
        const cached = await this.cacheService.getFromCache<
            DailyUsageByDeveloperResultContract[] | UsageByDeveloperResultContract[]
        >(cacheKey);
        if (cached) return cached;

        const usages = daily
            ? await this.tokenUsageService.getDailyUsageByPr(query)
            : await this.tokenUsageService.getUsageByPr(query);

        const pullRequestsMap = await this.getPullRequestsMap(
            usages,
            query.organizationId,
        );

        const mapped = this.mapUsagesWithDevelopers(usages, pullRequestsMap);

        let result:
            | DailyUsageByDeveloperResultContract[]
            | UsageByDeveloperResultContract[];
        if (query.developer) {
            result = mapped.filter(
                (usage) => usage.developer === query.developer,
            );
        } else if (!daily) {
            result = this.groupByDeveloperAndModel(mapped);
        } else {
            result = mapped;
        }

        const ttl =
            query.end.getTime() < startOfTodayUtc()
                ? DEV_TTL_PAST_MS
                : DEV_TTL_CURRENT_MS;
        await this.cacheService.addToCache(cacheKey, result, ttl);
        return result;
    }

    private async getPullRequestsMap(
        usages: { prNumber: number }[],
        organizationId: string,
    ): Promise<Map<number, IPullRequestUserMapping>> {
        // Get unique PR numbers
        const uniquePrNumbers = [...new Set(usages.map((u) => u.prNumber))];

        if (uniquePrNumbers.length === 0) {
            return new Map();
        }

        // PERF: Batch fetch all PRs in a single query instead of N+1
        const pullRequests = await this.pullRequestsService.findManyByNumbers(
            uniquePrNumbers,
            organizationId,
        );

        // Build map from results
        const pullRequestsMap = new Map<number, IPullRequestUserMapping>();
        for (const pr of pullRequests) {
            pullRequestsMap.set(pr.number, pr);
        }

        return pullRequestsMap;
    }

    private mapUsagesWithDevelopers(
        usages: (UsageByPrResultContract | DailyUsageByPrResultContract)[],
        pullRequestsMap: Map<number, IPullRequestUserMapping>,
    ) {
        return usages.map((usage) => {
            const pr = pullRequestsMap.get(usage.prNumber);
            const developer = pr?.user?.username || 'unknown';

            return {
                ...usage,
                developer,
            };
        });
    }

    private groupByDeveloperAndModel(
        usages: UsageByDeveloperResultContract[],
    ): UsageByDeveloperResultContract[] {
        const grouped = new Map<string, UsageByDeveloperResultContract>();

        for (const usage of usages) {
            const { developer, model, ...rest } = usage;
            const key = `${developer}-${model}`;

            if (!grouped.has(key)) {
                grouped.set(key, { developer, model, ...rest });
            } else {
                const existing = grouped.get(key)!;

                existing.input += rest.input;
                existing.output += rest.output;
                existing.total += rest.total;
                existing.outputReasoning += rest.outputReasoning;

                grouped.set(key, existing);
            }
        }

        return Array.from(grouped.values());
    }
}
